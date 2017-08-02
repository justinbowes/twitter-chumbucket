const Log = {
  levels: ['trace', 'debug', 'info', 'warn', 'error'],  
  toIndex(s) {
    return Math.max(Log.levels.indexOf(s), 0);
  },
};
Object.assign(Log, {
  level: Log.toIndex(process.env.LOG_LEVEL || 'debug')
});
Log.levels.forEach(level => {
  const index = Log.toIndex(level);
  Log[level] = (...args) => {
    if (Log.level <= index) console[level](...args); // eslint-disable-line no-console
  };
  Log.always = console.info; // eslint-disable-line no-console
});

module.exports = Log;