const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = (...a) => console.error(new Date().toISOString(), '[ERR]', ...a);
module.exports = { log, err };