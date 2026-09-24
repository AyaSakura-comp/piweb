/** Backward compatibility for already-open clients whose header still sends gpt-usage.
 * New composer requests stay explicit; pi gpt-usage is always the explicit GPT alias.
 * Pure data: importing this into the web tier must not load worker credentials.
 */
export function resolveWebUsageCommand(command: string, model: string, source?: string): string {
  if (
    command === 'gpt-usage' &&
    source !== 'composer' &&
    model.trim().toLowerCase().startsWith('claude-code/')
  )
    return 'claude-usage';
  return command;
}
