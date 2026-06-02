/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Interaction,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;

export async function startDiscord(): Promise<void> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Required for DM message events in discord.js.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, handleMessage);
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));

  return new Promise<void>((resolve, reject) => {
    const onReady = async (ready: Client<true>) => {
      cleanup();
      botId = ready.user.id;

      // Build a trigger pattern that matches @pi, @pi-agent, or any guild nicknames
      const names = [config.triggerName, ready.user.username];
      for (const guild of ready.guilds.cache.values()) {
        const me = guild.members.me;
        if (me?.nickname) {
          names.push(me.nickname);
        }
      }
      const uniqueNames = [...new Set(names)].filter(Boolean);
      const namePattern = uniqueNames
        .map(escapeRegExp)
        .sort((a, b) => b.length - a.length)
        .join('|');
      triggerPattern = new RegExp(`^@(?:${namePattern})\\b`, 'i');

      logger.info(
        { tag: ready.user.tag, id: botId, triggerPattern: triggerPattern.toString() },
        'Discord bot connected',
      );

      try {
        await registerGlobalCommands(ready);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register global slash commands');
      }

      resolve();
    };

    const onStartupError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client?.off(Events.ClientReady, onReady);
      client?.off(Events.Error, onStartupError);
    };

    client!.once(Events.ClientReady, onReady);
    client!.once(Events.Error, onStartupError);
    client!.login(config.discordToken).catch(onStartupError);
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    }
  } catch (err: any) {
    logger.error({ err: err.message, id: interaction.id }, 'Interaction handler failed');
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore our own messages only. Other bots are allowed to @-tag us so that
  // bot-to-bot handoffs (e.g. notifiers, webhooks) can drive a response —
  // the trigger check below stops random bot chatter from being processed.
  if (message.author.id === botId) return;

  const isDM = !message.guild;
  const channelId = message.channelId;
  const jid = `dc:${channelId}`;

  // ── Build content ──
  let content = message.content;
  const senderName =
    message.member?.displayName || message.author.displayName || message.author.username;
  const sender = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Translate @bot mentions / role mentions → trigger format
  if (client?.user) {
    const hasUserMention =
      message.mentions.users.has(botId) ||
      content.includes(`<@${botId}>`) ||
      content.includes(`<@!${botId}>`);

    const hasRoleMention = message.guild
      ? message.mentions.roles.some((role) => {
          const me = message.guild?.members.me;
          return me?.roles.cache.has(role.id) ?? false;
        })
      : false;

    const isMentioned = hasUserMention || hasRoleMention;

    if (isMentioned) {
      // Strip user mention
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

      // Strip bot role mentions
      if (message.guild) {
        const me = message.guild.members.me;
        if (me) {
          for (const roleId of me.roles.cache.keys()) {
            content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), '').trim();
          }
        }
      }

      if (!triggerPattern.test(content)) {
        content = `@${config.triggerName} ${content}`;
      }
    }
  }

  // Attachments → extract metadata for downstream download
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Discord attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // Reply context
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      const refAuthor = ref.member?.displayName || ref.author.displayName || ref.author.username;
      content = `[Reply to ${refAuthor}] ${content}`;
    } catch {
      // deleted message
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register guild channels based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as TextChannel).name || 'unknown';
    const name = `${guildName} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered guild channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Trigger check ──
  // `alwaysRequireTrigger` forces the prefix for guild channels, but
  // 1-on-1 contexts (DMs and dedicated threads) are exempt — there's no
  // ambiguity about who's being addressed. The per-channel `requiresTrigger`
  // flag still applies (e.g. an explicit override would still be honored).
  const inThread = !isDM && message.channel.isThread();
  const mustTrigger =
    channel.requiresTrigger || (config.alwaysRequireTrigger && !inThread && !isDM);
  if (mustTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // ── Auto-thread ──
  // When enabled, a triggering message in a top-level guild text channel spins
  // up a thread off that message; the conversation is then routed into the
  // thread (registered without a trigger requirement so follow-ups flow freely).
  // Already-in-thread messages and DMs fall through unchanged.
  let targetJid = jid;
  if (config.autoThread && !isDM && !message.channel.isThread()) {
    try {
      const thread = await message.startThread({
        name: buildThreadName(senderName, content),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      targetJid = `dc:${thread.id}`;
      if (!getChannel(targetJid)) {
        const threadReg: RegisteredChannel = {
          jid: targetJid,
          name: `${channel.name} ▸ ${thread.name}`,
          folder: `ch_${thread.id}`,
          requiresTrigger: false,
          isMain: false,
          modelOverride: channel.modelOverride,
          thinkingOverride: channel.thinkingOverride,
          cwdOverride: channel.cwdOverride,
        };
        dbRegisterChannel(threadReg);
        logger.info({ jid: targetJid, name: threadReg.name }, 'Opened and registered thread');
      }
    } catch (err: any) {
      // Missing thread permissions, etc. — fall back to replying in-channel.
      logger.warn({ jid, err: err.message }, 'Failed to open thread, replying in channel');
    }
  }

  // ── Enqueue ──
  enqueueMessage({
    channelJid: targetJid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
  });
  logger.info(
    { jid: targetJid, sender: senderName, len: content.length },
    'Message enqueued',
  );
}

// ── Outbound ──

const DISCORD_MAX_LENGTH = 2000;

export async function sendResponse(jid: string, text: string): Promise<boolean> {
  if (!client) return false;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }

    const textChannel = channel as TextChannel | DMChannel;

    if (text.length <= DISCORD_MAX_LENGTH) {
      await textChannel.send(text);
    } else {
      // Split at line boundaries when possible
      const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await textChannel.send(chunk);
      }
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

/**
 * Send a reply with file attachments (Method C outbox delivery). Reuses the
 * gateway's already-connected client (unlike sendFilesToDiscord, which logs in a
 * fresh client for the standalone CLI). Oversized/missing files are skipped.
 */
export async function sendFilesResponse(
  jid: string,
  text: string,
  files: string[],
): Promise<boolean> {
  if (!client) return false;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }
    const textChannel = channel as TextChannel | DMChannel;

    const valid: string[] = [];
    for (const f of files) {
      try {
        const size = statSync(f).size;
        if (config.maxAttachmentBytes > 0 && size > config.maxAttachmentBytes) {
          logger.warn({ jid, file: f, size }, 'Skipping attachment over size limit');
        } else {
          valid.push(f);
        }
      } catch {
        logger.warn({ jid, file: f }, 'Attachment not readable, skipping');
      }
    }

    const attachments = await Promise.all(
      valid.map(async (f) => new AttachmentBuilder(await readFile(f), { name: basename(f) })),
    );

    // Fall back to a plain text reply if nothing attachable survived.
    if (attachments.length === 0) {
      return sendResponse(jid, text || '(empty response)');
    }

    let body: string | undefined = text && text.length > 0 ? text : undefined;
    if (body && body.length > DISCORD_MAX_LENGTH) {
      // Send the long text in chunks; attach files to the final chunk.
      const chunks = splitMessage(body, DISCORD_MAX_LENGTH);
      for (let i = 0; i < chunks.length - 1; i++) {
        await textChannel.send(chunks[i]);
      }
      await textChannel.send({ content: chunks[chunks.length - 1], files: attachments });
    } else {
      await textChannel.send({ content: body, files: attachments });
    }

    logger.info(
      { jid, files: attachments.length, length: text?.length ?? 0 },
      'Response sent (with files)',
    );
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send files');
    return false;
  }
}

export async function setTyping(jid: string): Promise<void> {
  if (!client) return;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  } catch {
    // best-effort
  }
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    logger.info('Discord bot stopped');
  }
}

export function getBotTag(): string | undefined {
  return client?.user?.tag;
}

// ── Helpers ──

function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a Discord-safe thread title (max 100 chars) from sender + message. */
function buildThreadName(senderName: string, content: string): string {
  const snippet = content.replace(/\s+/g, ' ').trim();
  const raw = snippet ? `${senderName}: ${snippet}` : senderName;
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}
