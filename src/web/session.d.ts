import "cookie-session";

declare global {
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      userId?: number;
      flash?: { kind: string; text: string } | null;
    }
  }
}
