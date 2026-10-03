import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const name = '@laveesingh/golem';
export function packageLocation(caller) {
    let current = path.dirname(fileURLToPath(caller));
    for (;;) {
        const marker = path.join(current, '.golem-render.json');
        if (fs.existsSync(marker)) {
            const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
            if (value.name !== name ||
                value.schema_version !== 1 ||
                typeof value.target !== 'string')
                throw Error(`invalid Golem render marker: ${marker}`);
            return { root: current, kind: 'render' };
        }
        const manifest = path.join(current, 'package.json');
        if (fs.existsSync(manifest)) {
            const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (value.name === name)
                return { root: current, kind: 'package' };
        }
        const parent = path.dirname(current);
        if (parent === current)
            throw Error(`Golem package/render root not found from caller: ${caller}`);
        current = parent;
    }
}
export function packageRoot(caller) {
    return packageLocation(caller).root;
}
export function roleAssetsRoot(caller) {
    const location = packageLocation(caller);
    return path.join(location.root, location.kind === 'render' ? 'roles' : 'substrate/roles');
}
export function runtimeFile(caller, relative) {
    const root = packageRoot(caller), source = path.join(root, relative), emitted = path.join(root, 'dist', relative.replace(/\.ts$/, '.js'));
    if (fs.existsSync(source))
        return source;
    if (fs.existsSync(emitted))
        return emitted;
    throw Error(`Golem runtime file missing: ${relative} in ${root}`);
}
