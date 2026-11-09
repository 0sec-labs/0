module.exports = input => {
  const target = {};
  for (const [path, value] of Object.entries(input)) {
    const parts = path.split('.');
    if (parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return target;
    let current = target;
    for (const key of parts.slice(0, -1)) current = current[key] ??= {};
    current[parts.at(-1)] = value;
  }
  return target;
};
