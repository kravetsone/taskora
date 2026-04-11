// Nest's decorators store constructor paramtypes via reflect-metadata.
// Vitest doesn't load it for us, so do it once per worker before any
// @Injectable class is evaluated.
import "reflect-metadata";
