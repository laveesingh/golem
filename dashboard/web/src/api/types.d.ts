export interface paths {
    "/api/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** JsonValue */
        "def-0": string | number | boolean | (null) | components["schemas"]["def-0"][] | {
            [key: string]: components["schemas"]["def-0"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    createTicket: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    project_id: string;
                    title: string;
                    /** @default task */
                    kind?: ("spec" | "task" | "doc") | (null);
                    /** @default  */
                    body?: string | (null);
                    /** @default markdown */
                    body_format?: "markdown" | "html" | "" | (null);
                    priority?: string | (null);
                    /** @default [] */
                    labels?: string[];
                    parent_id?: string | (null);
                    assignee?: string | (null);
                    created_by?: string | (null);
                    source_ref?: string | (null);
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        seq: number;
                        project_id: string;
                        kind: "spec" | "task" | "doc";
                        title: string;
                        body: string;
                        body_format: "markdown" | "html";
                        body_revision: number;
                        state: "todo" | "in_progress" | "blocked" | "review" | "done" | "archived";
                        priority: string | (null);
                        labels: string[];
                        parent_id: string | (null);
                        assignee: string | (null);
                        created_by: string;
                        dispatched_to: string | (null);
                        dispatched_at: string | (null);
                        source_ref: string | (null);
                        created_at: string;
                        updated_at: string;
                        pseq: number;
                        display_id: string;
                        outline?: ({
                            id: string;
                            parent_id: string | (null);
                            kind: string;
                            tag: string;
                            heading: string | (null);
                            short_text: string;
                            hash: string;
                            mermaid_error?: components["schemas"]["def-0"];
                        } & {
                            [key: string]: unknown;
                        })[];
                        mermaid_errors?: components["schemas"]["def-0"][];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code?: string;
                        statusCode?: number;
                        message?: string;
                        block_id?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Default Response */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code?: string;
                        statusCode?: number;
                        message?: string;
                        block_id?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Default Response */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code?: string;
                        statusCode?: number;
                        message?: string;
                        block_id?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        code?: string;
                        statusCode?: number;
                        message?: string;
                        block_id?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        ok: true;
                        projects_root: string;
                        project_count: number;
                        server_time: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
}
