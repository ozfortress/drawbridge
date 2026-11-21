/** Version reported by /healthz. The image build supplies SOURCE_COMMIT. */
export const VERSION = (process.env['SOURCE_COMMIT'] ?? '').slice(0, 7) || '2.0.0';
