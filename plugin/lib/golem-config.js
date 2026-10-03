// Config owner: reads are zero-write; only explicit save publishes schema v1.
import { validateConfig, validateLegacyConfig, } from './contracts/config-validator.js';
import { configJsonPath } from './golem-home.js';
import { VersionedFileError } from "./read-versioned.js";
import { readVersioned, writeVersioned } from "./versioned-store.js";
const defaults = () => ({
    schema_version: 1,
    dispatch: { unackedWindowMinutes: 5 },
    harnesses: { claudecode: { enabled: true } },
});
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function deepMerge(base, override) {
    if (!isObject(base) || !isObject(override))
        return override ?? base;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const merged = isObject(value) && isObject(base[key])
            ? deepMerge(base[key], value)
            : value;
        // JSON extension names are data, including __proto__; never invoke setters.
        Object.defineProperty(out, key, {
            value: merged,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return out;
}
export function loadConfig() {
    return deepMerge(defaults(), readVersioned(configJsonPath(), {
        schema: Object.assign(validateConfig, { default: defaults }),
        current: 1,
        migrations: {
            0: (value) => {
                if (!validateLegacyConfig(value))
                    throw new VersionedFileError('VERSIONED_DATA_INVALID', configJsonPath());
                return { ...value, schema_version: 1 };
            },
        },
    }).value);
}
export function isHarnessEnabled(target) {
    return Boolean(loadConfig().harnesses?.[target]?.enabled);
}
export function saveConfig(input) {
    writeVersioned(configJsonPath(), input, {
        schema: validateConfig,
        version: 1,
    });
}
