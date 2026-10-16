// Standalone only: follow the OS theme. Embedded in cc, the bridge has already
// set data-cc-theme and owns the dark class.
(function () {
  var root = document.documentElement;
  if (root.hasAttribute('data-cc-theme')) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () { root.classList.toggle('dark', mq.matches); };
  apply();
  mq.addEventListener('change', apply);
})();
