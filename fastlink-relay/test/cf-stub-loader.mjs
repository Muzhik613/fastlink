// Test-only: resolve the Workers runtime module to a stub so the relay sources load under node.
const STUB = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'
  + ' export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,' + encodeURIComponent(STUB), shortCircuit: true };
  return next(spec, ctx);
}
