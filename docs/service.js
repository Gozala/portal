// @flow strict

self.addEventListener("install", function(event) {
  console.log(`Access point service worker is installed ${self.origin}`, event)
  // Cache all the assets that we may need so they can be served offline.
  event.waitUntil(initCache())
})

self.addEventListener("activate", function(event) {
  console.log(`Access point service worker is activated ${self.origin}`, event)
  // At the moment we claim all the clients. In the future we should
  // consider how do we deal with SW updates when former one already has
  // clients.
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", async function(event) {
  console.log(`Access point received a fetch request ${self.origin}`, event)
  const response = matchRoute(event.request)
  event.respondWith(response)
})

// This service worker serves a REST endpoint for interacting with a node in the
// p2p network (where browser instance is that node). It receives `MessagePort`
// instance that represents a connection and an `origin` of the site initating
// it. This allows service to can manage connections and use corresponding origin
// for access control.
// Inititating site embeds `companion/bridge.html` in an `iframe` and post a
// message with a `MessagePort` to it. Then `bridge.html` forwards `MessagePort`
// and `event.source.origin` to this service worker. This ceremony is in place
// because SW will only respond to sources from the same origin which is what
// `iframe` with `componion/bridge.html` accomplishes.
self.addEventListener("message", function({ data, ports, source }) {
  const [port] = ports
  const { origin } = data
  const connection = Connection.new(origin, port)
  console.log(`Access point received connection from "${origin}"`, connection)
})

class Connection {
  /*::
  origin:string
  port:MessagePort
  */
  constructor(origin, port) {
    this.origin = origin
    this.port = port
  }
  static new(origin, port) {
    const self = new this(origin, port)
    self.spawn()
    return self
  }
  spawn() {
    this.port.onmessage = (message /*:Object*/) => this.receive(message.data)
    this.port.start()
    this.keepAlive()
  }
  async keepAlive() {
    let start = Date.now()
    while (true) {
      await sleep(100)
      this.port.postMessage({ type: "alive", time: Date.now() })
    }
  }
  async receive(
    request /*:{id:string, url:string, headers:Headers, method:string, body:ArrayBuffer}*/
  ) {
    console.log(
      `Access point received request from "${this.origin}" connection`,
      request
    )

    const body =
      request.method === "GET"
        ? null
        : request.method === "HEAD"
        ? null
        : request.body
    const response = await satelliteRoute(
      new Request(request.url, {
        headers: request.headers,
        method: request.method,
        body: body
      })
    )
    const buffer = await response.arrayBuffer()
    this.port.postMessage(
      {
        type: "response",
        id: request.id,
        url: response.url,
        redirected: response.redirected,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: buffer
      },
      [buffer]
    )
  }
}

const initCache = async () => {
  const cache = await caches.open("companion")
  return cache.addAll([
    "./",
    "./main.js",
    "./companion/embed.js",
    "./companion/service.js"
  ])
}

const matchRoute = request => {
  const url = new URL(request.url)
  const { pathname, hostname } = url
  const [base, ...entries] = pathname.slice(1).split("/")
  switch (base) {
    // Serves static assets for the embedders
    case "":
    case "main.js":
    case "companion": {
      return companionRoute(request)
    }
    case "keep-alive/ping": {
      return keepAlivePing(request)
    }
    case "keep-alive/pong": {
      return keepAlivePong(request)
    }
    // Disable for now since GH pages do not handler * subdomains.
    // For IPFS / IPNS routes we will want to perfrom redirects to move CID into
    // origin (for isolation) and serve data from there.
    // case "ipfs":
    // case "ipns": {
    //   return subdomainRoute(request)
    // }
    // All the other routes JUST proxy to the native app.
    default: {
      return satelliteRoute(request)
    }
  }
}

const mainRoute = request => {
  const body = `<h1>Hello there</h1><p>You've fetched ${request.url}</p>`
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/html"
    }
  })
}

// Serves static assets for the embedders.
const companionRoute = async request => {
  const cache = await caches.open("companion")
  const response = await cache.match(request)
  if (response) {
    return response
  } else {
    return notFound(request)
  }
}

const keepAlivePing = async request => {
  await sleep(60 * 1000)
  return new Response.redirect("/keep-alive/ping")
}

const keepAlivePong = async request => {
  await sleep(60 * 1000)
  return new Response.redirect("/keep-alive/pong")
}

// Non existing documents under `companion` route.
const notFound = async request => {
  return new Response("<h1>Page Not Found</h1>", {
    status: 404,
    headers: {
      "content-type": "text/html"
    }
  })
}

const subdomainRoute = async request => {
  const { pathname } = new URL(request.url)
  const [_base, protocol, cid, ...rest] = pathname.slice(1).split("/")
  const path = rest.join("/")
  return new Response("", {
    status: 301,
    statusText: "Moved Permanently",
    headers: {
      Location: `https://${cid}.${protocol}.lunet.link/${path}`
    }
  })
}

// This is a hack to prevent service worker from being suspended, because when
// it's suspended all the service workers connected to it through ports are no
// longer able to talk to it.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const REST_SERVICE_URL = new URL("https://127.0.0.1:9000")

const updateHost = (url, hostURL) =>
  new URL(`${url.pathname}${url.search}`, hostURL)

// This just routes requests to local systray app. In practice we would want to
// try bunch of different ways to get the content instead.
const satelliteRoute = async request => {
  try {
    const url = new URL(request.url)
    const endpointURL = updateHost(url, REST_SERVICE_URL)
    console.log(
      `Access point proxying request for ${url.href} to native app at ${
        endpointURL.href
      }`
    )

    const requestHeaders = new Headers(request.headers)
    requestHeaders.delete("upgrade-insecure-requests")
    requestHeaders.delete("origin")
    requestHeaders.delete("dnt")
    requestHeaders.delete("accept")
    requestHeaders.delete("user-agent")
    requestHeaders.delete("x-requested-with")

    const body =
      request.method === "GET"
        ? null
        : request.method === "HEAD"
        ? null
        : await request.arrayBuffer()

    const response = await fetch(endpointURL, {
      method: request.method,
      headers: requestHeaders,
      body
    })
    const headers = new Headers(response.headers.entries())

    if (response.url !== endpointURL.href) {
      const location = updateHost(new URL(response.url), url)
      headers.set("location", location.href)
      return new Response(response.body, {
        status: 302,
        headers
      })
    } else {
      return new Response(response.body, {
        status: response.status,
        headers
      })
    }
  } catch (error) {
    return new Response(error.toString(), {
      status: 500
    })
  }
}
