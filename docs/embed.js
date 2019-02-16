// @flow strict

/*::
import * as Data from "./lunet/data.js"
*/

export class LunetClient {
  /*::
  ownerDocument:Document
  params:URLSearchParams
  host:HTMLIFrameElement
  status:HTMLElement
  isConnected:boolean
  handleEvent:Event => mixed
  connected:Promise<mixed>
  controlled:Promise<mixed>
  port:MessagePort
  */
  static new(ownerDocument /*:Document*/) {
    const client = new this(ownerDocument)
    return client
  }
  constructor(ownerDocument /*:Document*/) {
    this.ownerDocument = ownerDocument
    const status = this.ownerDocument.createElement("span")

    this.status = status
    this.params = new URLSearchParams(ownerDocument.location.search)
    this.isConnected = true
    this.connectedCallback()
  }
  connectedCallback() {
    if (this.isConnected) {
      const { serviceWorker } = navigator
      if (serviceWorker) {
        connect(
          this,
          serviceWorker
        )
      } else {
        setStatus(this, "🚫")
      }
    }
  }
  disconnectedCallback() {}
  handleEvent(event /*:Event*/) {
    switch (event.type) {
      case "message": {
        return receive(this, event)
      }
    }
  }
  get serviceURL() {
    return getSetting(this, "service", "./lunet.js")
  }
  get scope() {
    return getSetting(this, "scope", "./")
  }
  get mount() {
    return getSetting(this, "mount", "")
  }
  get serviceWorkerVersion() {
    return this.params.get("sw-version")
  }
  get service() {
    const serviceWorker = navigator.serviceWorker
    return serviceWorker ? serviceWorker.controller : null
  }
}

export const connect = async (
  client /*:LunetClient*/,
  serviceWorker /*:ServiceWorkerContainer*/
) => {
  const { mount, serviceURL, scope, serviceWorkerVersion } = client
  const swv = serviceWorkerVersion ? `&swv=${serviceWorkerVersion}` : ""

  const src = `${serviceURL}?${swv}`
  const { port1, port2 } = new MessageChannel()
  port1.addEventListener("message", client)
  serviceWorker.addEventListener("message", client)
  self.top.postMessage({ type: "connect", port: port2 }, "*", [port2])

  client.port = port1

  if (!serviceWorker.controller) {
    setStatus(client, "⚙️")
    const registration = await serviceWorker.register(src, {
      scope,
      type: "classic"
    })
  }
  const controlled = serviceWorker.controller
    ? Promise.resolve()
    : when("controllerchange", serviceWorker)

  client.controlled = controlled

  setStatus(client, "🎛")
  client.port.start()

  await client.controlled
  setStatus(client, "🛰")

  activate(client)
}

const activate = async (client /*:LunetClient*/, event /*:any*/) => {
  const document = client.ownerDocument
  const response = await fetch(document.location.href)
  const content = await response.text()

  const parser = new DOMParser()
  const parsed /*:any*/ = parser.parseFromString(content, "text/html")
  const root /*:{head:HTMLHeadElement, body:HTMLBodyElement} & Document*/ = parsed
  // Remove old nodes
  const $document /*:any*/ = document
  const {
    head,
    body
  } /*:{head:HTMLHeadElement, body:HTMLBodyElement}*/ = $document

  // collect scripts scripts
  const scripts = []
  const links = []
  for (const source of [...root.querySelectorAll("script")]) {
    const script = document.createElement("script")
    const link = document.createElement("link")
    link.href = source.src
    link.rel = "preload"
    link.as = "script"
    links.push(link)

    for (const { name, value, namespaceURI } of source.attributes) {
      if (namespaceURI) {
        script.setAttributeNS(namespaceURI, name, value)
      } else {
        script.setAttribute(name, value)
      }
    }
    scripts.push(script)
    head.append(link)
    source.remove()
  }

  head.append(...links)

  head.append(...document.adoptNode(root.head).childNodes)

  const display = body.style.display
  body.style.display = "none"
  body.innerHTML = ""
  body.append(...document.adoptNode(root.body).childNodes)

  for (const script of scripts) {
    head.append(script)
    await when("load", script)
  }
  body.style.display = display
}

export const receive = (client /*:LunetClient*/, event /*:any*/) => {
  if (event.source instanceof ServiceWorker) {
    return request(client, event)
  } else {
    return respond(client, event)
  }
}

export const request = async (
  client /*:LunetClient*/,
  { data } /*:Data.Request*/
) => {
  // await client.connected

  console.log("Client is forwarding request", data)

  client.port.postMessage(data, transfer(data.request))
}

export const respond = async (
  client /*:LunetClient*/,
  { data } /*:Data.Response*/
) => {
  await client.controlled
  const { service } = client

  console.log("Client received response, forwarding to proxy", data)

  if (service) {
    service.postMessage(data, transfer(data.response))
  } else {
    setStatus(client, "🚫")
  }
}

export const getSetting = (
  client /*:LunetClient*/,
  name /*:string*/,
  fallback /*:string*/ = ""
) /*:string*/ => {
  const meta = client.ownerDocument.querySelector(`meta[name=${name}]`)
  const value = meta ? meta.getAttribute("content") : null
  if (value != null && value !== "") {
    return value
  } else {
    return fallback
  }
}

const setStatus = (client, status) => {
  client.status.textContent = status
}

const when = (type, target) =>
  new Promise(resolve => target.addEventListener(type, resolve, { once: true }))

const transfer = data => (data.body instanceof ArrayBuffer ? [data.body] : [])

LunetClient.new(document)
