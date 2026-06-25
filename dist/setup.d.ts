import type { TestProject } from 'vitest/node';
declare module 'vitest' {
    interface ProvidedContext {
        serverUrl: string;
        wsUrl: string;
    }
}
export declare function setup(project: TestProject): Promise<void>;
export declare function teardown(): Promise<void>;
