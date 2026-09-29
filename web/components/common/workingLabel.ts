/** "Ethan AI is working", "Ethan AI and Caden AI are working", "Ethan AI and 2 others are working". */
export function workingLabel(names: readonly string[]): string {
  const [first = 'An agent', second] = names;
  if (names.length <= 1) return `${first} is working`;
  if (names.length === 2) return `${first} and ${second ?? ''} are working`;
  return `${first} and ${names.length - 1} others are working`;
}
