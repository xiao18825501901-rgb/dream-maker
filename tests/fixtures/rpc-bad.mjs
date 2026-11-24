// OFFLINE malformed transport fixture.
process.stdin.on('data', () => process.stdout.write('{"method":"event","params":[]}\n'));
