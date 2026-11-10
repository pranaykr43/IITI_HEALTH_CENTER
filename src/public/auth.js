/* eslint-env browser */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? 'Hide' : 'Show';
      button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} password`);
      button.setAttribute('aria-pressed', String(reveal));
      input.focus();
    });
  });
  document.querySelectorAll('[data-auth-form]').forEach((form) => {
    form.addEventListener('submit', () => {
      const button = form.querySelector('[data-submit-button]');
      if (!button) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.querySelector('.button-label')?.setAttribute('hidden', '');
      button.querySelector('.button-loading')?.removeAttribute('hidden');
    });
  });
});
