export const PI_AI_CAPABILITY_MARK = 'LEASE-WRX:pi-ai-system-capability-v1';

export function patchPiAiSystemCapability(source) {
  if (source.includes(PI_AI_CAPABILITY_MARK)) return { changed: false, source };
  const gate = 'supportsMidConvoSystemMessages: "withhold",\n\tsupportsMidConvoToolAdditions: "withhold"';
  const schema = 'const compatProfile = z.object({';
  for (const anchor of [gate, schema]) {
    if (source.split(anchor).length !== 2) throw new Error('pi-ai 能力补丁锚点缺失或不唯一');
  }
  return {
    changed: true,
    source: source.replace(gate, 'supportsMidConvoSystemMessages: "offer",\n\tsupportsMidConvoToolAdditions: "withhold"')
      .replace(schema, `// ${PI_AI_CAPABILITY_MARK}\n${schema}\n\tsupportsMidConvoSystemMessages: z.boolean(),`),
  };
}
