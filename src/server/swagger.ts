import swaggerJSDoc from "swagger-jsdoc";
import { AppSwagger } from "."


interface SwaggerSchema {
    openapi: string;
    info: {
        title: string;
        version: string;
    };
    paths: Record<string, Record<string, any>>;
}


export class SwaggerDoc {
    static apiDoc = (swaggerPath: AppSwagger[]) => {
        const swagger: SwaggerSchema = {
            openapi: '3.0.0',
            info: { title: 'API Documentation', version: '1.0.0' },
            paths: {}
        };

        for (const endpoint of swaggerPath) {
            const { path, method, body, params, response, tag } = endpoint;

            if (!swagger.paths[path]) {
                swagger.paths[path] = {};
            }

            swagger.paths[path][method] = {
                summary: `${method.toUpperCase()} ${path}`,
                tags: [tag],
                requestBody: Object.keys(body).length > 0 ? {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: Object.fromEntries(
                                    Object.entries(body).map(([key, type]) => [key, { type }])
                                )
                            }
                        }
                    }
                } : undefined,
                parameters: Object.entries(params).map(([key, type]) => ({
                    name: key,
                    in: 'path',
                    required: true,
                    schema: {
                        type
                    }
                })),
                responses: {
                    '200': {
                        description: 'Successful response',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: Object.fromEntries(
                                        Object.entries(response).map(([key, type]) => [key, { type }])
                                    )
                                }
                            }
                        }
                    },
                    '400': {
                        description: 'Bad Request'
                    },
                    '500': {
                        description: 'Internal Server Error'
                    }
                }
            };
        }


        const swaggerPaths: swaggerJSDoc.Options = {
            definition: {
                info: swagger.info,
                openapi: swagger.openapi,
                paths: swagger.paths
            },
            apis: [],
        }
        return swaggerPaths
    }
}