(function () {
  const form = document.getElementById('rsvp');
  const thanks = document.getElementById('thanks');
  const errorsBox = document.getElementById('errors');
  const count = form.elements.headcount;

  fetch('/api/config').then((r) => r.json()).then((c) => {
    const a = document.getElementById('qmail');
    a.href = 'mailto:' + c.questionsEmail;
    a.textContent = c.questionsEmail;
  }).catch(() => {});

  form.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = (parseInt(count.value, 10) || 1) + Number(b.dataset.step);
      count.value = Math.min(30, Math.max(1, v));
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    errorsBox.hidden = true;
    try {
      const res = await fetch('/api/rsvp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      const out = await res.json();
      if (!out.ok) throw out.errors || ['Something went wrong. Please try again.'];
      const n = Number(data.headcount);
      document.getElementById('thanks-msg').textContent =
        (out.updated ? 'Your RSVP was updated: ' : 'Thanks, ' + data.name.split(' ')[0] + '! We have ') +
        n + (n === 1 ? ' person' : ' people') + ', bringing ' + data.dish + '.';
      form.hidden = true; thanks.hidden = false;
      thanks.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (errs) {
      errorsBox.innerHTML = '';
      (Array.isArray(errs) ? errs : ['Could not reach the server. Please try again.']).forEach((m) => {
        const p = document.createElement('p'); p.textContent = m; errorsBox.appendChild(p);
      });
      errorsBox.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Send my RSVP';
    }
  });

  document.getElementById('again').addEventListener('click', () => {
    form.reset(); count.value = 1; thanks.hidden = true; form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth' });
  });
})();
