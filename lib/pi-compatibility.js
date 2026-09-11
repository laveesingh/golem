export const SUPPORTED_PI_VERSION = '0.85.1';
export const MIN_PI_NODE = Object.freeze({ major: 22, minor: 19 });

export function piNodeSupported(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > MIN_PI_NODE.major || (major === MIN_PI_NODE.major && minor >= MIN_PI_NODE.minor);
}

export function piCompatibility(piVersion) {
  const observed = typeof piVersion === 'string' && piVersion.trim() ? piVersion.trim() : null;
  return {
    status: observed == null ? 'unverified' : observed === SUPPORTED_PI_VERSION ? 'supported' : 'unsupported',
    pi_version: observed,
    supported_pi_version: SUPPORTED_PI_VERSION,
    node_requirement: `>=${MIN_PI_NODE.major}.${MIN_PI_NODE.minor}`,
  };
}
