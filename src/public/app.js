/* eslint-env browser */
// Progressive enhancements only: every form works without this script.
(() => {
  function initPasswordToggles() {
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
  }

  function initSubmitStates() {
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
  }

  // Open-slot picker for the scheduling desk. Slot data comes from the server in clinic
  // wall-clock time, so the browser never has to do time-zone arithmetic.
  function initSlotPickers() {
    const source = document.querySelector('[data-slot-board]');
    if (!source) return;
    let board;
    try { board = JSON.parse(source.dataset.slotBoard || '[]'); } catch { return; }

    document.querySelectorAll('[data-schedule-form]').forEach((form) => {
      const select = form.querySelector('[data-doctor-select]');
      const picker = form.querySelector('[data-slot-picker]');
      const daysEl = form.querySelector('[data-slot-days]');
      const gridEl = form.querySelector('[data-slot-grid]');
      const input = form.querySelector('[data-slot-input]');
      if (!select || !picker || !daysEl || !gridEl || !input) return;

      const pressOnly = (container, selected) => {
        container.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button === selected)));
      };

      const renderSlots = (day) => {
        gridEl.replaceChildren();
        day.slots.forEach((slot) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'slot';
          button.textContent = slot.label;
          button.setAttribute('aria-pressed', String(input.value === slot.value));
          if (slot.taken) {
            button.disabled = true;
            button.setAttribute('aria-label', `${slot.label}, already booked`);
          } else {
            button.setAttribute('aria-label', `${day.label}, ${slot.label}`);
            button.addEventListener('click', () => {
              input.value = slot.value;
              pressOnly(gridEl, button);
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
          }
          gridEl.append(button);
        });
      };

      const render = () => {
        const doctor = board.find((entry) => String(entry.id) === select.value);
        daysEl.replaceChildren();
        gridEl.replaceChildren();
        if (!doctor || !doctor.days.length) {
          picker.hidden = !doctor;
          if (doctor) {
            const note = document.createElement('p');
            note.className = 'slot-empty';
            note.textContent = 'No open slots in the next two weeks. Type a time below instead.';
            gridEl.append(note);
          }
          return;
        }
        picker.hidden = false;
        let firstOpen = null;
        doctor.days.forEach((day) => {
          const open = day.slots.filter((slot) => !slot.taken).length;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'slot-day';
          const label = document.createElement('span');
          label.textContent = day.label;
          const count = document.createElement('small');
          count.textContent = open ? `${open} open` : 'Full';
          button.append(label, count);
          button.setAttribute('aria-pressed', 'false');
          if (!open) button.classList.add('is-full');
          button.addEventListener('click', () => { pressOnly(daysEl, button); renderSlots(day); });
          daysEl.append(button);
          if (open && !firstOpen) firstOpen = { button, day };
        });
        const start = firstOpen || { button: daysEl.firstElementChild, day: doctor.days[0] };
        pressOnly(daysEl, start.button);
        renderSlots(start.day);
      };

      select.addEventListener('change', render);
      input.addEventListener('input', () => pressOnly(gridEl, null));
      if (select.value) render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initPasswordToggles();
    initSubmitStates();
    initSlotPickers();
  });
})();
