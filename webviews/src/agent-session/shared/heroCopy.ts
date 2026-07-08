export function heroGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) {
    return "Up late.";
  }
  if (hour < 12) {
    return "Good morning.";
  }
  if (hour < 18) {
    return "Good afternoon.";
  }
  return "Good evening.";
}

export const HERO_PROMPT = "What are we working on?";
