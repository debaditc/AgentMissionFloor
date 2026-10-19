// Settings come from environment variables. AMF_* (AgentMissionFloor) is the current prefix;
// the original AMB_* names are still honoured so older setups keep working.
export function setting(name: string): string | undefined {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  return env?.[`AMF_${name}`] ?? env?.[`AMB_${name}`];
}
