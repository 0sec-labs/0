module.exports = input => {
  function merge(target, value) {
    for (const key of Object.keys(value)) {
      
      if (value[key] && typeof value[key] === 'object') {
        target[key] ??= {}; merge(target[key], value[key]);
      } else target[key] = value[key];
    }
    return target;
  }
  return merge({}, input);
};
