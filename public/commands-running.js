const states = {
  running: '執行中',
  returned: '工具已回傳（退出碼未提供）',
  succeeded: '成功',
  failed: '失敗',
  cancelled: '已取消',
  unknown: '狀態未知／追蹤中斷',
};
const agents = {
  'not-observed': '尚未觀察到 AGY 收到完成輸出',
  'output-received': '輸出已回到 AGY 工具事件；尚未觀察到後續動作',
  continued: '已觀察到 AGY 後續動作',
};
export function createCommandsRunningView({ api, getParent }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'subagents-dialog commands-running';
  dialog.setAttribute('aria-label', '背景命令');
  const header = document.createElement('header');
  header.className = 'subagents-header';
  const heading = document.createElement('div');
  heading.className = 'subagents-heading';
  const title = document.createElement('h2');
  title.textContent = '背景命令 · AGY';
  const closeButton = document.createElement('button');
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', '關閉背景命令');
  heading.append(title);
  header.append(heading, closeButton);
  const note = document.createElement('p');
  note.className = 'subagents-note';
  note.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.className = 'subagents-body commands-list';
  dialog.append(header, note, list);
  document.body.append(dialog);
  let timer;
  let epoch = 0;
  function close() {
    epoch++;
    clearTimeout(timer);
    dialog.close();
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', () => {
    epoch++;
    clearTimeout(timer);
  });
  async function refresh(parent, generation) {
    if (epoch !== generation || !dialog.open) return;
    if (getParent()?.key !== parent.key) {
      close();
      return;
    }
    try {
      const data = await api(parent.url);
      if (epoch !== generation || getParent()?.key !== parent.key || !dialog.open) return;
      const openIds = new Set(
        [...list.querySelectorAll('details[open]')].map((el) => el.dataset.id),
      );
      const top = list.scrollTop;
      list.replaceChildren();
      note.textContent =
        '只顯示實際觀察到的事件。CLI 結束後不代表背景程序完成。' +
        (data.limited ? ' 僅涵蓋最近 1000 筆事件。' : '');
      if (!data.commands.length) list.textContent = '尚無命令紀錄';
      for (const command of data.commands) {
        const row = document.createElement('article');
        row.className = 'command-row';
        row.dataset.state = command.state;
        const heading = document.createElement('div');
        if (command.state === 'running') {
          const spinner = document.createElement('span');
          spinner.className = 'command-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          heading.append(spinner);
        }
        heading.append(document.createTextNode(states[command.state] || states.unknown));
        const code = document.createElement('pre');
        code.textContent = command.command;
        const status = document.createElement('p');
        status.textContent =
          (agents[command.agent] || agents['not-observed']) +
          (command.nextAction ? `：${command.nextAction}` : '');
        const metadata = document.createElement('p');
        metadata.textContent =
          `開始：${new Date(command.startedAt).toLocaleTimeString()} · 更新：${new Date(command.updatedAt).toLocaleTimeString()}` +
          (command.exitCode !== undefined ? ` · Exit ${command.exitCode}` : '');
        const detail = document.createElement('details');
        detail.dataset.id = command.id;
        detail.open = openIds.has(command.id);
        const summary = document.createElement('summary');
        summary.textContent = '查看輸出';
        const output = document.createElement('pre');
        output.textContent = command.output || '尚無輸出';
        detail.append(summary, output);
        row.append(heading, code, status, metadata, detail);
        list.append(row);
      }
      list.scrollTop = top;
    } catch {
      if (epoch === generation) {
        note.textContent = '無法更新命令狀態；將重新嘗試。';
        list.replaceChildren();
      }
    } finally {
      if (epoch === generation && dialog.open)
        timer = setTimeout(() => refresh(parent, generation), 1000);
    }
  }
  return {
    close,
    open() {
      const parent = getParent();
      if (!parent) return;
      clearTimeout(timer);
      const generation = ++epoch;
      list.replaceChildren();
      note.textContent = '載入命令紀錄…';
      dialog.showModal();
      void refresh(parent, generation);
    },
  };
}
