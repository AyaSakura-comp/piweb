// A stand-in for a tool like browser_intent in test/pi-secrets-extension.test.ts:
// it reports the argument it was given and whether this process's environment
// holds the login detail it names, without printing the value.
export default function probe(pi: any): void {
  pi.registerTool({
    name: 'probe',
    label: 'Probe',
    description: 'Report the goal and whether the named login detail is available.',
    parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
    async execute(_id: string, params: { goal: string }) {
      const value = process.env.PIWEB_SECRET_GITHUB_PASS;
      // Whether the argument still says the name: the result itself is scrubbed, so
      // echoing the goal could not tell a filled-in value from the name.
      const kept = params.goal.includes('$PIWEB_SECRET_GITHUB_PASS') && !(value && params.goal.includes(value));
      const text = `kept-names=${kept} env=${value ? `set:${value.length}` : 'unset'}`;
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}
