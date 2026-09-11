// Native development loads each sheet explicitly so any failed sheet is retryable.
// Vite substitutes the compiled css/style.css URL when building for distribution.
export default [
  '/css/layout.css',
  '/css/header.css',
  '/css/panels.css',
  '/css/controls.css',
  '/css/player.css',
  '/css/vu-meter.css',
  '/css/drawers.css',
  '/css/components.css',
  '/css/helpers.css',
  '/css/report.css',
  '/css/account.css',
  '/css/troubleshooting.css'
];
