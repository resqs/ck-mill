import { web3, core, sale, sire } from './eth/web3'
import db from './db/'

import { autobirth } from './eth/autobirther'

// TODO: blocklock to pause new block import handlers until the previous one finishes
// TODO: we are not eliminating expired due dates properly


////////////////////////////////////////
// Updates an existing (maybe empty) duedates array based on arrays of pregnant and birth events
// pure function, no side effects
// (duedates, pregos, births) => duedates
// where
// - pregos[i] = { matronid: 123, blockn: 460, cooldownend: 464 }
//   if we got a pregnant event for kitty 123 at block 460 and it'll be ready to give birth at block 464
// - births[i] = { matronid: 456, blockn: 457 }
//   if we got a birth event for kitty 456 at block 457
// - duedates[i] = { matronid: 123, blockn: 464 }
//   if kitty 123 is still pregnant and will be due on block 464
//   there should only be one due date per matronid
const update = (duedates, pregos, births) => {

  // console.log(`${new Date().toISOString()} Updating list of ${duedates.length} duedates according to ${births.length} birth events and ${pregos.length} pregnant events`)

  pregos.forEach(preg=>{ // for each pregnancy event

    // translate results to proper types
    const matronid = Number(preg.matronid)
    const cooldownend = Number(preg.cooldownend)

    let isNew = true // does this kitty have an entry in duedates yet?
    
    // search through existing due dates
    for (let i=0; i<duedates.length; i++) {

       // does this matronid already have an entry in duedates?
      if (matronid === duedates[i].matronid){
        isNew = false
        // if this one is more recent, overwrite the old one
        if (cooldownend > duedates[i].blockn) {
          duedates[i].matronid = cooldownend
          break // there should only be one due date per matronid
        }
      }
    }

    // if this kitty doesn't have an entry in duedates yet, add one
    if (isNew) {
      duedates.push({ matronid: matronid, blockn: cooldownend })
    }
  })

  births.forEach(birth=>{ // for each birth event

    // translate results to proper types
    const matronid = Number(birth.matronid)
    const block = Number(birth.blockn)

    // search through existing due dates
    for (let i=0; i<duedates.length; i++) {
      // remove any duedates that were before this kitty's most recent birth
      if (matronid === duedates[i].matronid && block >= duedates[i].blockn) {
        duedates.splice(i, 1)
        break // there should only be one due date per matronid
      }
    }
  })

  // Sort due dates so that more recent ones are first
  duedates.sort((a,b) => { return a.blockn-b.blockn })

  // double check everything if we have too many due dates on our calendar
  return core.methods.pregnantKitties().call().then(res=>{

    const panic = () => {
      console.log(`${new Date().toISOString()} Error: Our due date info is dangerously out of date, exiting...`)
      process.exit(1)
    }

    // too many due dates? double check what we got
    if (res < duedates.length) {
      console.log(`${new Date().toISOString()} WARN: we have too many duedates, double checking with the blockchain...`)
      return doublecheck(duedates).then(dds => {
        // oh no, are we still missing prego events
        return (res > dds.length) ? panic() : dds
      })

    // oh no, we're missing prego events
    } else if (res > duedates.length) {
      panic()

    } else {
      return duedates
    }
  })
}

////////////////////////////////////////
// Double check each due date & remove any that expired w/out us noticing
// (duedates) => duedates
// pure function, no side effects
const doublecheck = (duedates) => {

  // create a copy to remove items from
  var output = duedates.slice(0)

  // loop through the kitties we found and get the status of each
  const kittyPromises = output.map(dd => core.methods.getKitty(dd.matronid).call())

  // wait for all our kitty data to return
  return (Promise.all(kittyPromises).then(kitties=>{

    // remove any kitties we found that aren't pregnant anymore
    for (let i=0; i<kitties.length; i++) {

      // if this kitty isn't pregnant...
      if (!kitties[i].isGestating) {
        console.log(`${new Date().toISOString()} WARN: we thought kitty ${output[i].matronid} was pregnant it's not, removing...`)

        // remove this index from both arrays
        output.splice(i, 1)
        kitties.splice(i, 1)
        i -= 1 // We removed an element from the list so the same index now points to the next element
      }

    } // done looping through pregnant kitties, any non-pregnant ones have been removed

    return (output)

  }).catch((err)=>{
    console.error(err)
    // if we can't verify pregnancies then don't spend money trying to give birth
    process.exit(1)
  }))

}


////////////////////////////////////////
// Pulls old events out of our database and calls update()
// to populate our duedates calendar
// once our duedates calendar is initialized, it'll call it's callback
const init = (callback) => {
  web3.eth.getBlock('latest').then(res=>{

    const latest = Number(res.number)

    console.log(`${new Date().toISOString()} Initializing history before latest block: ${latest}`)

    const week = 4*60*24*7 // a week's worth of blocks

    // get all pregnancy events from the last week with most recent first
    const preg_query = `
      SELECT matronid,blockn,cooldownend
      FROM pregnant
      WHERE blockn > ${latest-week}
      ORDER BY blockn DESC;`

    // get all birth events from the last week with most recent first
    const birth_query = `
      SELECT matronid,blockn
      FROM birth
      WHERE blockn > ${latest-week}
      ORDER BY blockn DESC;`

    db.query(preg_query).then(pregos => {
      db.query(birth_query).then(births => {

        // update empty erray w historic birth/pregnancy events
        update([], pregos.rows, births.rows).then(duedates=>{
          console.log(`${new Date().toISOString()} initial due dates: ${duedates[0].blockn}, ${duedates[1].blockn}, ${duedates[2].blockn}`)
          callback(duedates)
        }).catch((error) => { console.error(`Failed to update based on ${pregos.rows.length} pregnancies and ${births.rows.length} births:`, error); process.exit(1) })

      }).catch((error) => { console.error(birth_query, error); process.exit(1) })
    }).catch((error) => { console.error(preg_query, error); process.exit(1) })

  }).catch((error) => { console.error('web3.eth.getBlock error:', error); process.exit(1) })
}


////////////////////////////////////////
// Listens for new events and calls updateDueDates()
// to keep our calendar up-to-date
const listen = (initialDDs) => {


  // shared between the two watcher functions below
  // this copy will be updated as our watchers watch
  var duedates = initialDDs

  // We'll manually get events each time we import a new block
  web3.eth.subscribe('newBlockHeaders', (err, header) => {
    if (err) { console.error(err); process.exit(1) }
    var block = Number(header.number)

    web3.eth.getAccounts().then(accounts => {
      web3.eth.getBalance(accounts[0]).then(balance => {
        console.log(` `)
        console.log(`${new Date().toISOString()} Imported block ${block}  (Current Balance: ${Math.round(Number(balance)/1000000000000)} uETH)`)
      })
    })

    // ethprovider's buggy & occasionally skips events and imported blocks
    // get events from several of the most recent blocks to protect against this
    core.getPastEvents('Birth', { fromBlock: block-4, toBlock: block }, (err, pastBirths) => {
      if (err) { console.error(err); process.exit(1) }
      core.getPastEvents('Pregnant', { fromBlock: block-4, toBlock: block }, (err, pastPregos) => {
        if (err) { console.error(err); process.exit(1) }

        // convert events to a form that update() understands
        const births = pastBirths.map(e=>{
          return ({
            matronid: Number(e.returnValues[2]),
            blockn: Number(e.blockNumber),
          })
        })

        const pregos = pastPregos.map(e=>{
          return ({
            matronid: Number(e.returnValues[1]),
            blockn: Number(e.blockNumber),
            cooldownend: Number(e.returnValues[3]),
          })
        })

        // Update our shared duedates variable.
        update(duedates, pregos, births).then(result => {

          duedates = result
          console.log(`${new Date().toISOString()} due dates:     ${duedates[0].blockn}, ${duedates[1].blockn}, ${duedates[2].blockn}`)


          // should we send an autobirther transaction?!
          let shouldSend = false
          for (let i=0; i<duedates.length; i++) { if (duedates[i].blockn === block+2) shouldSend = true }

          if (shouldSend) {
            const toBirth = []
            let i = 0
            while (duedates[i].blockn < block+5) {
              toBirth.push(duedates[i])
              i += 1
            }
            autobirth(toBirth) // Call function that will send our transaction
          }

        })
      })
    })
  })
}

////////////////////////////////////////
// Execute!
init(listen)

