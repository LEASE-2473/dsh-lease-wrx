







function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) % 24, Number(map.minute), Number(map.second));
  return asUTC - date.getTime();
}

export function dayRange(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs(timeZone, new Date(guess));
  const start = new Date(guess - offset);
  const offsetEnd = tzOffsetMs(timeZone, new Date(guess + 86400000));
  const end = new Date(guess + 86400000 - offsetEnd);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function diaryTimeWindow(date, timeZone, startTime = '00:00', endTime = '24:00') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日期必须是有效的 YYYY-MM-DD');
  const boundary = (clock, isEnd) => {
    if (isEnd && clock === '24:00') return dayRange(date, timeZone).end;
    if (typeof clock !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('时间必须为 HH:MM，结束时间可用 24:00');
    const desired = Date.parse(date + 'T' + clock + ':00Z');
    let actual = desired;
    for (let attempt = 0; attempt < 4; attempt++) actual = desired - tzOffsetMs(timeZone, new Date(actual));
    if (actual + tzOffsetMs(timeZone, new Date(actual)) !== desired) throw new Error('所选时区不存在这个本地时间');
    return new Date(actual).toISOString();
  };
  const start = boundary(startTime, false), end = boundary(endTime, true);
  if (end <= start) throw new Error('结束时间必须晚于开始时间');
  return { start, end };
}

