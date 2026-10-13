// Stand-in X server for display allocation and lifecycle tests.
if (process.env.FAKE_XVFB_MODE === 'exit') {
  process.stderr.write('fake display failure');
  process.exit(1);
}
process.stdout.write(`${process.pid}\n`);
setInterval(() => {}, 1000);
