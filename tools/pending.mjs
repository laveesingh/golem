const kind = process.argv[2];
const dependencies =
  kind === 'e2e'
    ? 'W4 design-system journeys/axe/screenshots and W5 simulator fixtures'
    : 'W3 emitted tarballs and W7 render artefacts';
console.error(
  kind +
    ' acceptance PENDING: ' +
    dependencies +
    '; legacy live commands are not invoked.',
);
process.exitCode = 2;
