const DISABLED_MESSAGE = "平台嵌入构建已禁用客户端模型密钥";

function clientKeysDisabled(): never {
  throw new Error(DISABLED_MESSAGE);
}

export function getClientImageApiKey(): string {
  return clientKeysDisabled();
}

export function setClientImageApiKey(_key: string): void {
  void _key;
  clientKeysDisabled();
}

export function hasClientImageApiKey(): boolean {
  return clientKeysDisabled();
}
