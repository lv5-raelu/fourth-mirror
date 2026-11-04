interface Role { id: string; permissions: string }
interface Overwrite { id: string; type: number; allow: string; deny: string }
const bits = (value: string): bigint => /^\d+$/.test(value) ? BigInt(value) : 0n;

export function betaChannelPermissions(guildId: string, botId: string, memberRoles: string[], roles: Role[], overwrites: Overwrite[]): boolean {
  const ids = new Set([guildId, ...memberRoles]);
  let permissions = roles.filter(role => ids.has(role.id)).reduce((value, role) => value | bits(role.permissions), 0n);
  if (permissions & 8n) return true;
  const apply = (entries: Overwrite[]): void => {
    const deny = entries.reduce((value, entry) => value | bits(entry.deny), 0n);
    const allow = entries.reduce((value, entry) => value | bits(entry.allow), 0n);
    permissions = (permissions & ~deny) | allow;
  };
  apply(overwrites.filter(entry => entry.id === guildId && entry.type === 0));
  apply(overwrites.filter(entry => entry.type === 0 && entry.id !== guildId && ids.has(entry.id)));
  apply(overwrites.filter(entry => entry.type === 1 && entry.id === botId));
  const required = 1024n | 2048n | 16384n;
  return (permissions & required) === required;
}
