import AppServer, { AppRouter, SwaggerInitUi, t } from './server'

// Example schemas
const paramsSchema = t.object({
    id: t.string(),
})

const querySchema = t.object({
    username: t.string(),
})

const bodySchema = t.object({
    content: t.string(),
})

// Instantiate the custom express app
const app = new AppServer()

app.use(SwaggerInitUi)

app
    .get(
        '/profile',
        async ({ query, res, req }) => {
            console.log(query.username)
            return { data: 'profile' }
        },
        { query: querySchema }
    )
    .post('/profile', async ({ body }) => {
        return { data: 'profile' }
    })

class Auth {
    constructor(private readonly router: AppRouter) { }

    get = this.router.get('/auth', async () => {
        return { data: 'auth' }
    })

    register = () => this.router
}

const router = new AppRouter()

router.post(
    '/profiles',
    async ({ body }) => {
        console.log(body.content)
        return { data: 'profile' }
    },
    { body: bodySchema }
)

router
    .get(
        '/profile/:id',
        async ({ params }) => {
            return { data: { id: params.id } }
        },
        {
            middleware: (req, res, next) => {
                console.log('Middleware executed')
                next()
            },
            detail: {
                summary: 'Get profile by id',
                description: 'Get profile by id',
                tags: ['profile'],
                params: [{
                    in: 'path',
                    name: 'id',
                    required: true,
                    schema: { type: 'string' }
                }],
                response: {
                    'success': {
                        type: 'object',
                        properties: {
                            id: { type: 'string' }
                        }

                    },
                    'bad request': {
                        type: 'object',
                        properties: {
                            message: { type: 'string' }
                        }
                    }
                }
            },
            params: paramsSchema,
        }
    )
    .get(
        '/profile',
        async ({ query }) => {
            return { data: 'profile' }
        },
        { query: querySchema }
    )

app.router('/api', router)
// app.router('/auth', new Auth(router).register())

app.listen(3000)
