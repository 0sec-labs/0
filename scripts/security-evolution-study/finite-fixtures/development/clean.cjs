module.exports = input => {
  function merge(target, value) {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (value[key] && typeof value[key] === 'object') {
        target[key] ??= Object.create(null); merge(target[key], value[key]);
      } else target[key] = value[key];
    }
    return target;
  }
  return merge(Object.create(null), input);
};
