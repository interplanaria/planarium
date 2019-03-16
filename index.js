const express = require('express')
const bitquery = require('bitquery')
const bitsocket = require('bitsocket')
const RpcClient = require('bitcoind-rpc')
const PQueue = require('p-queue')
const ip = require('ip')
const fs = require('fs')
const path = require('path');
const app = express()
const cors = require('cors')
const axios = require('axios')
const interlevel = require('interlevel')
const dotenv = require('dotenv')
const REGISTRY = "https://planaria.network/join"
const DEFAULT_WEB_PORT = 3000
dotenv.config({path: path.resolve(process.cwd(), 'planarium.env')})
console.log("####################")
console.log("# ENV...")
console.log("#", JSON.stringify(process.env, null, 2))
console.log("#")
try {
  const override = dotenv.parse(fs.readFileSync('child.env'))
  for (let k in override) {
    process.env[k] = override[k]
    console.log("# Overriding", k, ":", override[k])
  }
} catch (e) { }
console.log("# Final ENV:")
console.log("#", JSON.stringify(process.env, null, 2))
console.log("####################")

var GENES = {}
var currentPath = process.cwd()
var genePath = currentPath + "/genes"
var dirs = fs.readdirSync(genePath).filter(function (file) {
  return fs.statSync(genePath+'/'+file).isDirectory();
});
dirs.forEach(function(_path) {
  let pth = genePath + "/" + _path
  console.log("Reading", pth)
  GENES[_path] = {}
  fs.readdirSync(pth).forEach(function(file) {
    if (file === 'planaria.js') {
      let f = require(pth + "/" + file)
      if (f) {
        console.log("Found planaria.js")
        GENES[_path].planaria = f
      } else {
        console.log("planarium.js Not found")
      }
    } else if (file === 'planarium.js') {
      let f = require(pth + "/" + file)
      if (f) {
        console.log("Found planarium.js")
        GENES[_path].planarium = f
      } else {
        console.log("planarium.js Not found")
      }
    }
  })
})
/*
gene.planarium:
{
  query: {
    web: {
      v: 3,
      q: { find: {}, limit: 10 }
    },
    api: {
      timeout: 50000,
      concurrency: { aggregate: 7 },
      log: true
    }
  }
}
*/
var concurrencies = Object.keys(GENES).map(function(addr) {
  return GENES[addr].planarium.query.api.concurrency
})
// get the max conocurrency
var concurrency = 3
for(let i=0; i<concurrencies.length; i++) {
  if (concurrencies[i] > concurrency) {
    concurrency = concurrencies[i]
  }
}
const queue = new PQueue({concurrency: concurrency});

const BITCOIN_CONFIG = {
  rpc: {
    protocol: 'http',
    user: process.env.BITCOIN_USER,
    pass: process.env.BITCOIN_PASSWORD,
    host: (process.env.HOST ? process.env.HOST : ip.address()),
    port: process.env.BITCOIN_PORT,
    limit: parseInt(process.env.BITCOIN_CONCURRENCY)
  },
  zmq: {
    host: (process.env.HOST ? process.env.HOST : ip.address()),
    port: process.env.BITCOIN_ZMQ_PORT
  }
}
const PLANA_CONFIG = {
  zmq: {
    host: process.env.PLANA_ZMQ_HOST,
    port: process.env.PLANA_ZMQ_PORT,
  },
  mongo: {
    name: process.env.PLANA_DB_NAME,
    port: process.env.PLANA_DB_PORT,
    url: process.env.PLANA_DB_URL
  }
}
var Manager = {}
var sock
var meta = {}
var join = function() {
  // Send to planaria.network
  console.log("connecting to planaria network", JSON.stringify(meta, null, 2))
  axios.post(REGISTRY, meta).then(function (response) {
    console.log("Connected to planaria network")
  }).catch(function (error) {
    console.log(error);
  });
}
var kv = interlevel.client({ host: (process.env.HOST ? process.env.HOST :  ip.address()), port: 28337 })
var getclock = function(addr) {
  return new Promise(function(resolve, reject) {
    kv.get(addr, function(err, val) {
      if (err) {
        console.log(err)
        resolve(null)
      } else {
        resolve(val)
      }
    })
  })
}
var getclocks = async function() {
  let addresses = Object.keys(GENES)
  let clocks = {}
  for(let i=0; i<addresses.length; i++) {
    let addr = addresses[i]
    let clk = await getclock(addr).catch(function(e) {
      console.log(e)
    })
    clocks[addr] = clk
  }
  return clocks
}
var init = async function(routes) {
  const rpc = new RpcClient(BITCOIN_CONFIG.rpc)
  meta.host = process.env.DOMAIN
  meta.address = process.env.ADDRESS.split(',')
  rpc.getNetworkInfo(function(err, block) {
    console.log("networkinfo = ", block)
    meta.info = {}
    meta.info.version = block.result.version;
    meta.info.subversion = block.result.subversion;
    meta.info.protocolversion = block.result.protocolversion
    kv.get("genes", function(err, val) {
      if (err) console.log(err)
      meta.info.genes = val
      if (process.env.JOIN) {
        join()
      }
    })
  })
  console.log("# Bitquery Init...", GENES)
  // add a delay just to wait for planaria to initialize

  let topics = {}
  let transforms = {}
  let addresses = Object.keys(GENES)
  for (let i=0; i<addresses.length; i++) {
    let address = addresses[i]
    let gene = GENES[address]

    // build options
    let options = {
      url: "mongodb://" + (process.env.HOST ? process.env.HOST : ip.address()) + ":" + PLANA_CONFIG.mongo.port
    }
    if (gene.planaria.address) options.address = gene.planaria.address
    if (gene.planarium.query && gene.planarium.query.api) {
      let api = gene.planarium.query.api
      if (api.sort) options.sort = api.sort
      if (api.limit) options.limit = api.limit
      if (api.timeout) options.timeout = api.timeout
    }
    if (gene.planarium.transform) options.transform = gene.planarium.transform

    // bitquery init
    let db = await bitquery.init(options).catch(function(e) {
      console.log("Error", e)
    })
    Manager[gene.planaria.address] = {
      db: db
    }
    console.log("# Bitquery Initialized...")
    topics[gene.planaria.address] = gene.planarium.socket.topics
    transforms[gene.planaria.address] = gene.planarium.transform

    // oncreate
    if (gene.planarium.query && gene.planarium.query.api && gene.planarium.query.api.oncreate) {
      let oncreate = gene.planarium.query.api.oncreate
      console.log("planarium oncreate exists", oncreate)
      let fpath = "/fs/" + address
      console.log("fs path = ", fpath)
      await oncreate({ fs: { path: fpath } })
    } else {
      console.log("oncreate doesn't exist")
    }
  }
  console.log("# Bitsocket init", topics)
  sock = await bitsocket.init({
    bit: {
      zmq: {
        host: "planaria",
        port: PLANA_CONFIG.zmq.port
      },
      mongo: {
        host: (process.env.HOST ? process.env.HOST : ip.address()),
        port: PLANA_CONFIG.mongo.port
      },
    },
    topics: topics,
    transform: transforms,
    socket: {
      port: DEFAULT_WEB_PORT, app: app,
      concurrency: { mempool: 5 }
    }
  })
  console.log("# Bitsocket initialized..")

  app.set('view engine', 'ejs');
  app.use(express.static('public'))
  app.use(express.json());
  app.use(cors())

  app.get('/', async function(req, res) {
    let addresses = Object.keys(GENES)
    let clocks = await getclocks().catch(function(e) {
      console.log(e)
    })
    res.render('placeholder', {
      meta: meta,
      genes: addresses.map(function(addr) {
        let o = GENES[addr]
        o.address = addr
        o.clock = clocks[addr]
        return o
      })
    })
  })
  app.get('/readme/:address', function(req, res) {
    console.log("readme", req.params.address)
    let address = req.params.address
    fs.readFile(genePath + "/" + address + '/README.md', 'utf8', function(err, contents) {
      let gene = GENES[address]
      res.render('readme', {
        name: gene.planaria.name,
        description: gene.planaria.description,
        readme: contents
      })
    });
  })
  app.get('/info', async function(req, res) {
    let clk = await getclocks().catch(function(e) {
      console.log(e)
    })
    if (clk) {
      meta.info.clock = clk
      res.json(meta)
    } else {
      console.log(err)
      res.json({ error: 'no clock for ' + req.params.address })
    }
  })
  app.get(/^\/q\/([^\/]+)\/(.+)/, async function(req, res) {
    let apikey = req.header("key");
    if (apikey) {
      var address = req.params[0]
      var encoded = req.params[1]
      let r = JSON.parse(new Buffer(encoded, "base64").toString());
      if (r.q && r.q.aggregate) {
        // add to aggregate queue
        console.log("# Aggregate query. Adding to queue", queue.size)
        queue.add(async function() {
          // regular read
          try {
            let result = await Manager[address].db.read(address, r)
            if (GENES[address].planarium.query.log) {
              console.log("query = ", r)
              console.log("response = ", result)
            }
            res.json(result)
          } catch (e) {
            console.log("# e = ", e)
            res.json(e)
          }
        })
      } else {
        // regular read
        console.log("Regular read")
        console.log("Address = ", address)
        console.log("Manager = ", Manager)
        try {
          let result = await Manager[address].db.read(address, r)
          if (GENES[address].planarium.query.log) {
            console.log("query = ", r)
            console.log("response = ", result)
          }
          res.json(result)
        } catch (e) {
          console.log("# e = ", e)
          res.json(e)
        }
      }
    } else {
      res.json({
        status: "error",
        message: "Must set the 'key' header with an api key"
      })
    }
  })

  /*****************************************************
  * 
  * planarium.js
  *
  * {
  *   query: {
  *     default: {
  *       v: 3,
  *       q: { find: {} }
  *     },
  *     timeout: 50000,
  *     conocurrency: {"aggregate": 1 },
  *     log: true
  *   },
  *   socket: {
  *     default: {
  *       v: 3,
  *       q: { find: {} }
  *     },
  *     filter: async function(event) { ... }
  *   }
  * }
  *****************************************************/

  app.get(/^\/query\/([^\/]+)\/(.+)/, function(req, res) {
    let address = req.params[0]
    let encoded = req.params[1]
    if (GENES[address]) {
      let decoded = Buffer.from(encoded, 'base64').toString()
      let name = GENES[address].planaria.name
      res.render('query', { name: name, address: address, code: decoded, version: meta.info.subversion })
    } else {
      res.redirect('/')
    }
  })
  app.get(/^\/query\/(.+)/, function(req, res) {
    let address = req.params[0]
    let code = ""
    if (GENES[address]) {
      let name = GENES[address].planaria.name
      if (GENES[address] &&
          GENES[address].planarium &&
          GENES[address].planarium.query &&
          GENES[address].planarium.query.web
      ) {
        code = JSON.stringify(GENES[address].planarium.query.web, null, 2)
      }
      res.render('query', { name: name, address: address, code: code, version: meta.info.subversion })
    } else {
      res.redirect('/')
    }
  })
  app.get(/^\/socket\/([^\/]+)\/(.+)/, function(req, res) {
    let address = req.params[0]
    let encoded = req.params[1]
    if (GENES[address]) {
      let name = GENES[address].planaria.name
      let decoded = Buffer.from(encoded, 'base64').toString()
      res.render('socket', { name: name, address: address, code: decoded, items: [], version: meta.info.subversion })
    } else {
      res.redirect('/')
    }
  })
  app.get(/^\/socket\/(.+)/, function(req, res) {
    let address = req.params[0]
    if (GENES[address]) {
      let code = ""
      let name = GENES[address].planaria.name
      if (GENES[address].planarium && GENES[address].planarium.query && GENES[address].planarium.query.web) {
        code = JSON.stringify(GENES[address].planarium.socket.web, null, 2)
      }
      res.render('socket', { name: name, address: address, code: code, items: [], version: meta.info.subversion })
    } else {
      res.redirect('/')
    }
  })

  /*
  *  routes := {
  *    "/blah": function(req, res) {
  *      // do something      
  *    }
  *  }
  */
  if (routes) {
    Object.keys(routes).forEach(function(path) {
      let handler = routes[path] 
      app.get(path, handler)
    })
  }
  Object.keys(GENES).forEach(function(addr) {
    let gene = GENES[addr].planarium
    if(gene.query && gene.query.api && gene.query.api.routes) {
      console.log("# Custom routes for", addr, "\n", gene.query.api.routes)
      Object.keys(gene.query.api.routes).forEach(function(path) {
        let resolvedPath = "/" + addr + path
        let handler = gene.query.api.routes[path]
        console.log("resolved path = ", resolvedPath)
        console.log("handler = ", handler)
        app.get(resolvedPath, handler)
      })
    }
  })


  app.listen(DEFAULT_WEB_PORT, () => {
    console.log("######################################################################################");
    console.log("#")
    console.log("#  Planarium: Planaria Microservice")
    console.log("#  Serving Bitcoin through HTTP...")
    console.log("#")
    console.log(`#  Explorer: ${ip.address()}:${process.env.PLANARIUM_PORT}/query`);
    console.log(`#  API Endpoint: ${ip.address()}:${process.env.PLANARIUM_PORT}/q`);
    console.log("#")
    console.log("#  Learn more at https://docs.bitdb.network")
    console.log("#")
    console.log("######################################################################################");
  })
}
// if started as standalone, initialize
if (require.main === module) {
  init()
}
module.exports = {
  init: init,
}
