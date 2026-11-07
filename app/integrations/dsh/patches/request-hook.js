/** DSH请求接入生成器：只处理明确传入的干净宿主文本，不查找运行实例。 */
export const PATCH_MARK = 'LEASE-WRX:request-transform-v3';

function once(source, anchor) {
  if (source.split(anchor).length !== 2) throw new Error('宿主锚点不唯一或不存在：' + anchor);
}

export function patchRequestHook(source) {
  if (source.includes(PATCH_MARK)) return { changed: false, source };
  const assembly = 'const { assembly } = decision;';
  const derived = 'const derivedMessages = session.deriveMessages();';
  const freeze = 'for (const message of derivedMessages) {';
  const frozen = 'Object.freeze(derivedMessages);';
  const output = 'messages: derivedMessages,';
  for (const anchor of [assembly, derived, freeze, frozen, output]) once(source, anchor);
  const render = `${assembly}
        this.leaseWrxAssembly = { ...assembly, contexts: renderContextSections(assembly), sections: assembly.sections.map(section => ({ ...section, text: renderPrompt({ ...assembly, sections: [section] }) })) };`;
  const handoff = `// ${PATCH_MARK}
        const leaseWrxGenerationOptions = {};
        const leaseWrxTransform = globalThis[Symbol.for("lease-wrx.request-transform.v1")];
        if (leaseWrxTransform) {
          const messageTimes = {};
          for (const seq of session.surface?.nodes ?? []) {
            const event = session.log[seq];
            const message = session.deriveEventMessage(event);
            if (message?.id) messageTimes[message.id] = event.time;
          }
          const agentPreset = this.ctx?.sessionProjections?.stateOf
            ? this.ctx.sessionProjections.stateOf(session, "agentPreset")
            : (session.log ?? []).reduce((value, event) => event?.type === "agent-preset/selected" ? event.data.agentPreset : value, session.header?.agentPreset ?? null);
          const transformed = leaseWrxTransform({
            messages: boundaryMessages, messageTimes, generationOptions: leaseWrxGenerationOptions,
            sessionLog: session.log, surfaceNodes: session.surface?.nodes,
            provider: config.provider, model: config.model, tools: header.tools ?? [], toolHistory: session.toolHistory(),
            agentPreset, sessionId: session.id, parentSession: session.header?.parentSession,
            position, assembly: this.leaseWrxAssembly,
          });
          if (!Array.isArray(transformed)) throw new Error("LEASE WRX transform must return messages");
          boundaryMessages = transformed;
        }
        for (const message of boundaryMessages) {`;
  return {
    changed: true,
    source: source.replace(assembly, render)
      .replace(derived, `${derived}\n        let boundaryMessages = derivedMessages;`)
      .replace(freeze, handoff)
      .replace(frozen, 'Object.freeze(boundaryMessages);')
      .replace(output, '...leaseWrxGenerationOptions, messages: boundaryMessages,'),
  };
}
