//
// Upgrades a cluster to a newer version
//

load( './jstests/multiVersion/libs/multi_rs.js' )
load( './jstests/multiVersion/libs/multi_cluster.js' )
load( './jstests/libs/test_background_ops.js' )

var oldVersion = "2.0.6"
var newVersion = "latest"

// BIG OUTER LOOP, RS CLUSTER OR NOT!
for( var test = 0; test < 1; test++ ){
    
// TODO: RS Test messes up here
var isRSCluster = test == 1



jsTest.log( "Starting " + ( isRSCluster ? "(replica set)" : "" ) + " cluster..." )

var options = {
    
    mongosOptions : { binVersion : oldVersion },
    configOptions : { binVersion : oldVersion },
    shardOptions : { binVersion : oldVersion },
    
    separateConfig : true,
    sync : true,
    rs : isRSCluster
}

var st = new ShardingTest({ shards : 2, mongos : 2, other : options })


jsTest.log( "Starting parallel operations during upgrade..." )

var insertNS = "test.foo"
var shardedInsertNS = "test.bar"
    
var admin = st.s.getDB( "admin" )
var shards = st.s.getDB( "config" ).shards.find().toArray()

printjson( admin.runCommand({ enableSharding : shardedInsertNS }) )
printjson( admin.runCommand({ movePrimary : shardedInsertNS, to : shards[0]._id }) )
printjson( admin.runCommand({ shardCollection : shardedInsertNS, key : { _id : 1 } }) )

st.stopBalancer()

for( var i = 0; i < 5; i++ ){
    printjson( admin.runCommand({ split : shardedInsertNS, middle : { _id : i * 50 } }) )
    printjson( admin.runCommand({ moveChunk : shardedInsertNS, 
                                  find : { _id : i * 50 }, 
                                  to : shards[ i % shards.length ]._id }) )
}

function findAndInsert( mongosURL, ns ){
    
    var coll = null
    
    // Make sure we can eventually connect to the mongos
    assert.soon( function(){
        try{ 
            coll = new Mongo( mongosURL ).getCollection( ns + "" )
            return true
        }
        catch( e ){
            printjson( e )
            return false
        }
    })
    
    var count = 0
    
    jsTest.log( "Starting finds and inserts..." )
    
    while( ! isFinished() ){
        
        try{
            
            coll.insert({ _id : count, hello : "world" })
            assert.eq( null, coll.getDB().getLastError() )
            assert.neq( null, coll.findOne({ _id : count }) )
        }
        catch( e ){
            printjson( e )
        }
        
        count++
    }
    
    jsTest.log( "Finished finds and inserts..." )
    return count
}

var staticMongod = MongoRunner.runMongod({})

printjson( staticMongod )

var joinFindInsert = 
    startParallelOps( staticMongod, // The connection where the test info is passed and stored
                      findAndInsert,
                      [ st.s0.host, insertNS ] )
                      
var joinShardedFindInsert = 
    startParallelOps( staticMongod, // The connection where the test info is passed and stored
                      findAndInsert,
                      [ st.s1.host, shardedInsertNS ] )


jsTest.log( "Upgrading cluster..." )

st.upgradeCluster( newVersion )

jsTest.log( "Cluster upgraded." )

st.printShardingStatus()


// Allow more valid writes to go through
sleep( 10 * 1000 )


joinFindInsert()
joinShardedFindInsert()

var totalInserts = st.s.getCollection( insertNS ).find().sort({ _id : -1 }).next()._id
var dataFound = st.s.getCollection( insertNS ).count()

jsTest.log( "Found " + dataFound + " docs out of " + totalInserts + " inserted." )

assert.gt( dataFound / totalInserts, 0.5 )

var totalInserts = st.s.getCollection( shardedInsertNS ).find().sort({ _id : -1 }).next()._id
var dataFound = st.s.getCollection( shardedInsertNS ).find().itcount()

jsTest.log( "Found " + dataFound + " sharded docs out of " + tojson( totalInserts ) + " inserted." )

assert.gt( dataFound / totalInserts, 0.5 )

jsTest.log( "DONE!" )

st.stop()

} // END OUTER LOOP FOR RS CLUSTER