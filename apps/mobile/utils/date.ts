import { endOfWeek, format, parse, startOfWeek, subWeeks } from 'date-fns';
import { List } from '../types/types';

export function getWeekLabel(date: Date | string = new Date()) {
  if(typeof date === 'string') date = new Date(date);

  const startOf = (d: Date) => startOfWeek(new Date(d.setHours(0, 0, 0, 0)), { weekStartsOn: 0 });

  const weekStart = startOf(date);
  const weekEnd = endOfWeek(date, { weekStartsOn: 0 });

  const today = startOf(new Date());
  const lastWeek = startOf(subWeeks(today, 1));
  const nextWeek = startOf(subWeeks(today, -1));

  if (weekStart.getTime() === today.getTime()) {
    return 'This Week';
  } else if (weekStart.getTime() === lastWeek.getTime()) {
    return 'Last Week';
  } else if (weekStart.getTime() === nextWeek.getTime()) {
    return 'Next Week';
  }

  return `Week of ${format(weekStart, 'MMM d')}–${format(weekEnd, 'd')}`;
}


export function getPastWeeks(count: number): Date[] {
  return Array.from({ length: count }, (_, i) => subWeeks(new Date(), i));
}

export function getAvailableWeeks(lists: List[]): Date[] {
  return lists.map(w => new Date(w.weekStart)).sort((a, b) => {
    return b.getTime() - a.getTime();
  });
}


export const weekKeyFromDate = (d: Date) => format(startOfWeek(d, { weekStartsOn: 0 }), 'yyyy-MM-dd');
export const dateFromWeekKey = (key: string) => startOfWeek(parse(key, 'yyyy-MM-dd', new Date()), { weekStartsOn: 0 });