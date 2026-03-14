// src/logger.js
// Colored, timestamped console logger

import chalk from "chalk";

const ts = () => chalk.gray(`[${new Date().toISOString()}]`);

export const log = {
  info:    (...args) => console.log(ts(), chalk.cyan("ℹ INFO "), ...args),
  success: (...args) => console.log(ts(), chalk.green("✔ OK   "), ...args),
  warn:    (...args) => console.log(ts(), chalk.yellow("⚠ WARN "), ...args),
  error:   (...args) => console.error(ts(), chalk.red("✖ ERR  "), ...args),
  bundle:  (...args) => console.log(ts(), chalk.magenta("⚡ BNDL "), ...args),
  step:    (n, total, msg) =>
    console.log(ts(), chalk.blue(`[${n}/${total}]`), msg),
};
