# BTW switching and clearing

Root causes: side send disables the shared composer globally; re-entering BTW performs a control snapshot that queues behind the active send; async completion lacks reset fencing.

1. RED mobile E2E: hold a BTW POST, switch to main, send a main prompt, switch back without another GET; pending reply and separate drafts survive. Clear via confirmation removes only BTW history.
2. `public/btw-workspace.js`: persistent target switcher while thread is owned, cached switching during send, recipient-specific send disabled state, clear button with confirmation and busy guard, epoch-fenced completions.
3. Extend existing `/btw` POST with `action: clear`, worker action validation, and RPC bridge using the installed native `/btw:clear` command followed by verified snapshot. No native Pi database changes or extension rewrite.
4. RPC fake-process contract test and browser regression/recording. Avoid unrelated camera changes in verification.
5. Document deployment: backend and host worker change together; do not restart an active worker/current agent.
