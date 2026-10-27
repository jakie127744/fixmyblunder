// A repeating calendar event with an alert. A web app with no server cannot wake a closed phone,
// so the calendar does the nudging and works the same on iPhone, Android and desktop.
const pad = (n) => String(n).padStart(2, '0');
export const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');

export function reminderIcs(time, { url = '', now = new Date() } = {}) {
  if (!validTime(time)) throw new Error('Pick a time first.');
  const [h, m] = time.split(':');
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const text = 'Your Blunderprint set is ready. About ten minutes.';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blunderprint//Daily reminder//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:daily-reminder@blunderprint', `DTSTAMP:${stamp}`,
    `DTSTART:${d}T${h}${m}00`, 'DURATION:PT10M', 'RRULE:FREQ=DAILY', "SUMMARY:Blunderprint: today's set", `DESCRIPTION:${text}`,
    ...(url ? [`URL:${url}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}
