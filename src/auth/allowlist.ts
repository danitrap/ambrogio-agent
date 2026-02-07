export class TelegramAllowlist {
  constructor(private readonly allowedUserId: number) {}

  isAllowed(userId: number): boolean {
    return userId === this.allowedUserId;
  }
}
