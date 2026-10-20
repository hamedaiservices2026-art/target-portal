export function patchDatabaseId(wranglerJsoncText: string, databaseId: string): string;
export function parseDatabaseList(stdout: string): Array<{ uuid?: string; id?: string; name?: string }>;
export function findDatabaseId(list: Array<{ uuid?: string; id?: string; name?: string }>): string | undefined;
