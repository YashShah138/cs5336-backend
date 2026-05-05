function securityLog(event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    ...details,
  };
  console.log('[SECURITY]', JSON.stringify(entry));
}

module.exports = { securityLog };
