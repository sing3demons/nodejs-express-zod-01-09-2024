import express, {
    type Express,
    type Request,
    type Response,
    type NextFunction,
    type RequestHandler,
    Router,
    Application,
} from 'express'
import http from 'http'
import { Socket } from 'net'
import { v7 as uuid } from 'uuid'
import promBundle from 'express-prom-bundle'
import {
    z,
    ZodError,
    ZodObject,
    ZodString,
    type ZodTypeAny,
    type ZodRawShape,
    type ZodSchema,
    ZodNumber,
    ZodArray,
} from 'zod'
import { fromZodError } from 'zod-validation-error'
import swaggerJsDoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { SwaggerDoc } from './swagger'

const transaction = 'x-transaction-id'
const metricsMiddleware = promBundle({ includeMethod: true })

type ExtractParams<T extends string> = T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? [Param, ...ExtractParams<Rest>]
    : T extends `${infer _Start}:${infer Param}`
    ? [Param]
    : []

type ParamsObject<T extends string[]> = { [K in T[number]]: string }

type RouteHandler<P, B, Q> = (ctx: {
    params: P
    body: B
    query: Q
    req: Request
    res: Response
    next: NextFunction
}) => Promise<BaseResponse>

enum HttpMethod {
    GET = 'get',
    POST = 'post',
    PUT = 'put',
    PATCH = 'patch',
    DELETE = 'delete',
}

interface Route<
    T extends string = string,
    P extends ZodTypeAny = any,
    B extends ZodTypeAny = any,
    Q extends ZodTypeAny = any
> {
    path: T
    method: HttpMethod
    handler: RouteHandler<P, B, Q>
    schemas?: {
        params?: ZodSchema<P>
        body?: ZodSchema<B>
        query?: ZodSchema<Q>
        middleware?: RequestHandler
        detail?: SwaggerDetail
    }
}

function catchAsync(fn: (...args: any[]) => any) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch((err) => next(err))
    }
}

interface BaseResponse<T = unknown> {
    statusCode?: number
    message?: string
    /**
     * @default true
     */
    success?: boolean
    data?: T
    traceStack?: string
    page?: number
    pageSize?: number
    total?: number
}

function createParamsObject<T extends string>(path: T): ParamsObject<ExtractParams<T>> {
    const matches = path.match(/:(\w+)/g)
    const paramsArray = matches ? (matches.map((match) => match.substring(1)) as ExtractParams<T>) : []

    // Create and return the parameters object
    const paramsObject: ParamsObject<ExtractParams<T>> = {} as ParamsObject<ExtractParams<T>>

    paramsArray.forEach((param) => {
        paramsObject[param as keyof ParamsObject<ExtractParams<T>>] = ''
    })

    return paramsObject
}

function createZodSchema<T extends string>(path: T) {
    const paramsArray = createParamsObject(path)

    // Create a Zod schema where each parameter is a ZodString (or you can customize as needed)
    const shape: ZodRawShape = Object.keys(paramsArray).reduce((acc, key) => {
        acc[key] = z.string().nullable()
        return acc
    }, {} as ZodRawShape)

    const schema = z.object(shape) as ZodObject<{ [K in ExtractParams<T>[number]]: ZodString }>
    return schema.parse(paramsArray)
}

class HttpError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message)
        this.name = 'HttpError'
    }
}

function globalErrorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
    let statusCode = 500
    let message = 'An unknown error occurred'

    if (error instanceof HttpError) {
        statusCode = error.statusCode
    }

    if (error instanceof Error) {
        console.log(`${error.name}: ${error.message}`)
        message = error.message

        if (message.includes('not found')) {
            statusCode = 404
        }
    } else {
        console.log('Unknown error')
        message = `An unknown error occurred, ${String(error)}`
    }

    const data = {
        statusCode: statusCode,
        message,
        success: false,
        data: null,
        traceStack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined,
    }

    response.status(statusCode).send(data)
}

export type AppSwagger = {
    path: string
    method: HttpMethod
    detail?: SwaggerDetail
    body: Record<string, any>
    query: Record<string, any>
    params: Record<string, any>
    response: Record<string, any>
}

type TSwaggerObject = {
    name: string
    type: string
    required: boolean | false
    description?: string
}

type TResponses = {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean'
    properties?:
    | Record<string, { type: string; default?: string | number | object | []; nullable?: boolean }>
    | Record<string, TResponses>
    | Record<string, { type: string; properties: TResponses }>
    items?: TResponses | { type: string } | { type: string; properties: TResponses }
}

type IParameters = {
    in: 'path' | 'query'
    name: string
    schema: { type: string; enum?: string[]; default?: string | number | object | [] }
    required: boolean
}

type SwaggerDetail = {
    tags?: string[]
    summary?: string
    description?: string
    query?: IParameters[]
    body?: TSwaggerObject[]
    response?: {
        success?: TResponses
        'bad request'?: TResponses
        'internal server error'?: TResponses
    }
    params?: IParameters[]
}

class BaseRouter {
    public routes: Route[] = []
    protected swaggerPath: AppSwagger[] = []

    protected createHandler(
        handler: RouteHandler<any, any, any>,
        schemas?: { params?: ZodSchema<any>; body?: ZodSchema<any>; query?: ZodSchema<any> },
        schemaObject: Record<string, any> = {}
    ) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                this.validateRequest(req, schemas)
                if (Object.keys(schemaObject).length) {
                    this.validateParams(req, schemaObject)
                }
                this.preRequest(handler)(req, res, next)
            } catch (error) {
                this.handleError(error, res, next)
            }
        }
    }

    private validateParams(req: Request, schemaObject: Record<string, any>) {
        Object.keys(schemaObject).forEach((key) => {
            if (!req.params[key]) {
                throw new Error(`Parameter '${key}' is required`)
            }
        })
    }

    private validateRequest(
        req: Request,
        schemas?: { params?: ZodSchema<any>; body?: ZodSchema<any>; query?: ZodSchema<any> }
    ) {
        if (schemas?.params) schemas.params.parse(req.params)
        if (schemas?.body) schemas.body.parse(req.body)
        if (schemas?.query) schemas.query.parse(req.query)
    }

    private handleError(error: unknown, res: Response, next: NextFunction) {
        if (error instanceof ZodError) {
            const validationError = fromZodError(error)
            const msg = `${validationError.message}`.replace(/"/g, `'`)
            return res.status(400).json({
                success: false,
                message: msg,
                details: error.errors.map((err) => ({
                    path: err.path,
                    message: err.message,
                })),
            })
        } else if (error instanceof Error) {
            return res.status(500).json({
                success: false,
                message: 'Internal server error',
                traceStack: error.stack,
            })
        }
        next(error)
    }

    private preRequest(handler: RouteHandler<any, any, any>) {
        return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
            const ctx = {
                params: req.params,
                body: req.body,
                query: req.query,
                req: req as Request,
                res: res as Response,
                next,
            }
            const result = await handler(ctx)
            res.send({
                success: true,
                message: 'Request successful',
                ...result,
            } satisfies BaseResponse)
        })
    }

    protected addRoute<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        method: HttpMethod,
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        this.routes.push({ path, method, handler, schemas })
        return this
    }

    public get<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        return this.addRoute(HttpMethod.GET, path, handler, schemas)
    }

    public post<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        return this.addRoute(HttpMethod.POST, path, handler, schemas)
    }

    public put<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        return this.addRoute(HttpMethod.PUT, path, handler, schemas)
    }

    public patch<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        return this.addRoute(HttpMethod.PATCH, path, handler, schemas)
    }

    public delete<T extends string, P = ParamsObject<ExtractParams<T>>, B = unknown, Q = unknown>(
        path: T,
        handler: RouteHandler<P, B, Q>,
        schemas?: {
            params?: ZodSchema<P>
            body?: ZodSchema<B>
            query?: ZodSchema<Q>
            middleware?: RequestHandler
            detail?: SwaggerDetail
        }
    ) {
        return this.addRoute(HttpMethod.DELETE, path, handler, schemas)
    }
}

function zodToObject(schema: ZodSchema<any>): any {
    if (schema instanceof ZodString) {
        return 'string'
    } else if (schema instanceof ZodNumber) {
        return 'number'
    } else if (schema instanceof ZodArray) {
        const innerType = zodToObject(schema._def.type)
        return [innerType]
    } else if (schema instanceof ZodObject) {
        const shape = schema.shape
        const obj: Record<string, any> = {}
        for (const key in shape) {
            obj[key] = zodToObject(shape[key])
        }
        return obj
    } else {
        return 'unknown'
    }
}

function zodToSwagger(schema: ZodSchema<any>): any {
    if (schema instanceof ZodString) {
        return { type: 'string' }
    } else if (schema instanceof ZodNumber) {
        return { type: 'number' }
    } else if (schema instanceof ZodArray) {
        const innerType = zodToSwagger(schema._def.type)
        return { type: 'array', items: innerType }
    } else if (schema instanceof ZodObject) {
        const shape = schema.shape
        const obj: Record<string, any> = { type: 'object', properties: {} }
        for (const key in shape) {
            obj.properties[key] = zodToSwagger(shape[key])
        }
        return obj
    } else {
        return { type: 'unknown' }
    }
}

export function SwaggerInitUi(req: Request, res: Response, next: NextFunction) {
    next()
}

class AppServer extends BaseRouter {
    private readonly app: Express = express()
    constructor(cb?: () => void) {
        super()
        this.app.use(express.json())
        this.app.use(express.urlencoded({ extended: true }))
        this.app.use(metricsMiddleware)
        this.app.use((req: Request, _res: Response, next: NextFunction) => {
            if (!req.headers[transaction]) {
                req.headers[transaction] = `default-${uuid()}`
            }
            next()
        })

        cb?.()
    }

    public router(path: string, router: AppRouter, ...middleware: RequestHandler[]) {
        router?.routes?.forEach((r) => {
            const jsonString = r.handler
                .toString()
                .split('return')[1]
                .replace('}}', '}')
                .replace(/(\w+):/g, '"$1":')
            const schemaObject: AppSwagger = {
                path: `${path}${r.path}`,
                method: r.method,
                detail: r.schemas?.detail,
                body: r.schemas?.body ? zodToObject(r.schemas.body) : {},
                query: r.schemas?.query ? zodToObject(r.schemas.query) : {},
                params: r.schemas?.params ? zodToObject(r.schemas.params) : {},
                response: this.parseJson(jsonString),
            }
            this.swaggerPath.push(schemaObject)
        })
        this.app.use(path, middleware, router.register())
        this.routes.length = 0
    }

    private parseJson = (str: string) => {
        try {
            return JSON.parse(str)
        } catch (error) {
            return {}
        }
    }

    public use(...middleware: RequestHandler[]) {
        this.app.use(...middleware)
        return this
    }

    public listen(port: number | string, close?: () => Promise<void> | void) {
        this.routes.forEach((route) => {
            const { path, handler, schemas, method } = route
            const middlewares = schemas?.middleware ? [schemas.middleware] : []
            const schemaObject = createZodSchema(path)
            const jsonString = handler
                .toString()
                .split('return')[1]
                .replace('}}', '}')
                .replace(/(\w+):/g, '"$1":')
            const schema: AppSwagger = {
                path: path,
                method: method,
                detail: schemas?.detail,
                body: schemas?.body ? zodToObject(schemas.body) : {},
                query: schemas?.query ? zodToObject(schemas.query) : {},
                params: schemas?.params ? zodToObject(schemas.params) : {},
                response: JSON.parse(jsonString),
            }
            this.swaggerPath.push(schema)

            this.app.route(path)[method](...middlewares, this.createHandler(handler, schemas, schemaObject))
        })

        this.app._router.stack.forEach((middleware: any) => {
            if (middleware.name === 'SwaggerInitUi') {
                const swaggerOptions = new SwaggerDoc().apiDoc(this.swaggerPath)

                const swaggerSpec = swaggerJsDoc(swaggerOptions)
                this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
            }
        })

        console.log('swaggerPath', this.swaggerPath)
        this.swaggerPath.length = 0
        this.routes.length = 0

        this.app.use((req: Request, res: Response, _next: NextFunction) => {
            res.status(404).json({ message: 'Unknown URL', path: req.originalUrl })
        })
        this.app.use(globalErrorHandler)

        // listRoutes(this.app)

        const server = http.createServer(this.app).listen(port, () => {
            console.log(`Server is running on port: ${port}`)
        })

        const connections = new Set<Socket>()

        server.on('connection', (connection) => {
            connections.add(connection)
            connection.on('close', () => {
                connections.delete(connection)
            })
        })

        const signals = ['SIGINT', 'SIGTERM']
        signals.forEach((signal) => {
            process.on(signal, () => {
                console.log(`Received ${signal}, shutting down gracefully...`)
                server.close(() => {
                    console.log('Closed out remaining connections.')
                    close?.()
                    process.exit(0)
                })

                // If after 10 seconds the server hasn't finished, force shutdown
                setTimeout(() => {
                    console.error('Forcing shutdown as server is taking too long to close.')
                    connections.forEach((connection) => {
                        connection.destroy()
                    })
                    close?.()
                    process.exit(1)
                }, 10000)
            })
        })

        // this.app.listen(port, () => {
        //     console.log(`Server is running on port ${port}`);
        // });
    }
}

// Function to List All Routes
const listRoutes = (app: Application) => {
    const routes: { method: string; path: string }[] = []

    app._router.stack.forEach((middleware: any) => {
        console.log('middleware', middleware.name)
        if (middleware.route) {
            // Routes registered directly on the app
            const { path, stack } = middleware.route
            const methods = stack.map((layer: any) => layer.method.toUpperCase())
            methods.forEach((method: string) => routes.push({ method, path }))
            // console.log('middleware', JSON.stringify(middleware.route));
        } else if (middleware.name === 'router') {
            // Routes registered on routers
            middleware.handle.stack.forEach((handler: any) => {
                const { route } = handler
                if (route) {
                    const { path, stack } = route

                    const methods = stack.map((layer: any) => layer.method.toUpperCase())
                    methods.forEach((method: string) => routes.push({ method, path }))
                }
            })
        }
    })

    console.table(routes)
}

class AppRouter extends BaseRouter {
    constructor(private readonly instance: Router = Router()) {
        super()
    }

    public register() {
        this.routes.forEach((route) => {
            const { path, handler, schemas, method } = route
            const m = schemas?.middleware ? [schemas.middleware] : []
            const schemaObject = createZodSchema(path)

            this.instance.route(path)[method](...m, this.createHandler(handler, schemas, schemaObject))
        })

        return this.instance
    }
}

export { z as t, AppRouter }
export default AppServer
