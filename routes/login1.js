

var express = require("express"); 
var router = express.Router(); 
const app=express();  
const path= require("path");
// var con = require('../connection');  
var createError = require('http-errors');


const bodyParser = require("body-parser");
const encoder = bodyParser.urlencoded();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));

 app.use("/assets",express.static("assets")); 
 app.set('views', path.join(__dirname, 'views'));
 app.set("view engine" , "ejs");
 app.use(express.static(__dirname + '/views'));

const { render } = require('ejs');

require("../routes/db/conn");

// const port = process.env.PORT || 5000;
const static_path = path.join(__dirname, "../public");
const template_path = path.join(__dirname, "../views");
app.use(express.static(static_path));

//mail
const cors = require("cors");



router.use(cors());


const nodemailer = require("nodemailer");

router.get('/mail/:id', async function(req, res,next) {
   var data5=req.params.id; 
   let transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
          user: 'gfg882004@gmail.com', // host email address
           pass: process.env.SMTP_PASS,


      },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
      from: '"sanskaar OP" <gfg882004@gmail.com>', // sender address
      to: "cse210001075@iiti.ac.in", // list of receivers email Id's
      subject: "Hello ✔" + "vishesh", // Subject line
      text: "Hello world?", // plain text body
      html: "<b><h1>Hello world?</h1></b><p>sanskaar&&(navya)</p>", // html body
  });

  console.log("Message sent: %s", info.messageId);
  
   
      res.render("mailedsuccessfully",{data5});
 
});

var rating=require("./rating");
var loginadmin=require("./loginadmin");
var loginstudent=require("./loginstudent");
var logindoctor=require("./logindoctor");
var doctordetails=require("./doctordetails");
var collection=require("./appointment");
var visitors=require("./visitors");
var note=require("./note");
var history1=require("./history");
var blood=require("./blood");

var doctorrating=require("./doctorrating");
const { mainModule } = require("process");


app.use(express.urlencoded({ extended: false }));
// router.get("/mail", function(req,res,next) {
//    res.render("adminlogin");
//    main();
  

// });
router.get("/", function(req,res,next){
   res.render("homemain");
});  

router.get("/homemain",function(req,res,next) {
   res.render("homemain");
});   

router.get("/doctorlogin", function(req,res,next) {
    res.render("doctorlogin");
 });
 router.get("/studentlogin",function(req,res,next) {
    res.render("studentlogin");
 });
 router.get("/adminlogin", function(req,res,next) {
    res.render("adminlogin");
 });   
 router.get("/appointment",function(req,res,next) {
   res.render("appointment");
});  
router.get("/covid", function(req,res,next){
   res.render("covid");
});  
router.get("/status/:id/:id1/:id2", async function(req,res){
     var data5= req.params.id;
     var e=req.params.id1;
     var p=req.params.id2;
   res.render("status",{data5,e,p});
});  
router.get("/statusd/:id/:id1/:id2", async function(req,res){
   var data5= req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
 res.render("statusd",{data5,e,p});
});  
router.get("/feedback/:id/:id1/:id2/:doctor/:id3", async function(req,res){
   var data5= req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
   var assigneddoctor=req.params.doctor; 

   const check=await collection.findOne({
      _id:req.params.id3
     })  
     if(check.test!="--"){
 res.render("feedback",{data5,e,p,assigneddoctor});
     }else{
       res.render("notallowedfeedback");
     }
});  
router.get("/feedbacks/:id/:id1/:id2/:doctor/:id3", async function(req,res){
   var data5= req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
   var assigneddoctor=req.params.doctor; 
   const check=await collection.findOne({
      _id:req.params.id3
     })  
     if(check.test!="--"){
 res.render("feedbacks",{data5,e,p,assigneddoctor});
     }else{
       res.render("notallowedfeedback");
     }

}); 
router.get("/feedbackd/:id/:id1/:id2/:doctor/:id3", async function(req,res){
   var data5= req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
   var assigneddoctor=req.params.doctor;

 const check=await collection.findOne({
   _id:req.params.id3
  })  
  if(check.test!="--"){
res.render("feedbackd",{data5,e,p,assigneddoctor});
  }else{
    res.render("notallowedfeedback");
  }
}); 
router.get("/blood/:id", async function(req,res){
   var data5= req.params.id;
 res.render("blood",{data5});
});  
router.get("/bloods/:id", async function(req,res){
   var data5= req.params.id;
 res.render("bloods",{data5});
}); 
router.get("/bloodd/:id", async function(req,res){
   var data5= req.params.id;
 res.render("bloodd",{data5});
}); 
router.get("/bloodform/:id", async function(req,res){
   var data5= req.params.id;
 res.render("bloodform",{data5});
}); 
router.get("/bloodforms/:id", async function(req,res){
   var data5= req.params.id;
 res.render("bloodforms",{data5});
}); 
router.get("/bloodformd/:id", async function(req,res){
   var data5= req.params.id;
 res.render("bloodformd",{data5});
}); 
router.get("/admindashboards/:id",async function(req,res) {
   
   var data1;
   var data2;
   var data3;
   var data4;
   var data5=req.params.id;
   
   try{
       //first query
       let user_data = await loginadmin.count({}).exec();
       data1 = user_data;

       //second query
       let content_data = await loginstudent.count({}).exec();
       data3 = content_data;
 
       let content1_data = await doctordetails.count({}).exec();
       data2 = content1_data;

       let user_data2 = await collection.count({}).exec();
       data4 = user_data2;
       /////
       let five= await rating.count({star:5}).exec();
       rate5 = five;
       let four= await rating.count({star:4}).exec();
       rate4 = four;
       let three = await rating.count({star:3}).exec();
       rate3 = three;
       let two  = await rating.count({star:2}).exec();
       rate2 = two;
       let one = await rating.count({star:1}).exec();
       rate1 = one;
     

          
      
                  var sort = { rating : -1 };
                  doctorrating.find((err, data) => {
                        if (!err) {
                           res.render("admindashboard", {
                              data1,data2,data3,data4,data5,sampleData:data,rate5,rate4,rate3,rate2,rate1
                            });
                        } else {
                            console.log('Failed to retrieve the Course List: ');
                        }
                    }).sort(sort);   
           
        
}
catch(err){
 return res.status(400).json({err})
}
});  
router.get("/doctordashboards/:id",async function(req,res) {
   

 
try{ 
   // console.log(req.body);  
   const check=await logindoctor.findOne({
    name:req.params.id
   }) 

   
   if(check){
      
   
      var data1;
      var data2;
      var data3;
      var data4;
      var data5=check.name;
      var name1=check._id;
      
      try{
          //first query
          let user_data = await loginadmin.count({}).exec();
          data1 = user_data;
   
          //second query
          let content_data = await loginstudent.count({}).exec();
          data3 = content_data;
    
          let content1_data = await doctordetails.count({}).exec();
          data2 = content1_data;
          let user_data2 = await collection.count({}).exec();
          data4 = user_data2;
        
         
           
          
          let five= await rating.count({star:5}).exec();
          rate5 = five;
          let four= await rating.count({star:4}).exec();
          rate4 = four;
          let three = await rating.count({star:3}).exec();
          rate3 = three;
          let two  = await rating.count({star:2}).exec();
          rate2 = two;
          let one = await rating.count({star:1}).exec();
          rate1 = one;
        
                     var sort = { rating : -1 };
                     doctorrating.find((err, data) => {
                           if (!err) {
                              res.render("doctordashboard", {
                                 data1,data2,data3,data4,data5,name1,sampleData:data,rate5,rate4,rate3,rate2,rate1
                               });  
                           } else {
                               console.log('Failed to retrieve the Course List: ');
                           }
                       }).sort(sort); 
           
}
catch(err){
    return res.status(400).json({err})
}
    }else{
      res.render("invalid1")
   }
}catch{
   res.send("error")
}
})  ;

router.get("/studentdashboards/:id",async function(req,res) {
   

 
   try{ 
      // console.log(req.body);  
      const check=await loginstudent.findOne({
       name:req.params.id
      }) 
   
      
      if(check){
         
      
         var data1;
         var data2;
         var data3;
         var data4;
         var data5=check.name;
         var name1=check._id;
         
         try{
             //first query
             let user_data = await loginadmin.count({}).exec();
             data1 = user_data;
      
             //second query
             let content_data = await loginstudent.count({}).exec();
             data3 = content_data;
       
             let content1_data = await doctordetails.count({}).exec();
             data2 = content1_data;
             let user_data2 = await collection.count({}).exec();
             data4 = user_data2;
           
            
             let five= await rating.count({star:5}).exec();
             rate5 = five;
             let four= await rating.count({star:4}).exec();
             rate4 = four;
             let three = await rating.count({star:3}).exec();
             rate3 = three;
             let two  = await rating.count({star:2}).exec();
             rate2 = two;
             let one = await rating.count({star:1}).exec();
             rate1 = one;
             
      
           
                        var sort = { rating : -1 };
                        doctorrating.find((err, data) => {
                              if (!err) {
                                 res.render("studentdashboard", {
                                    data1,data2,data3,data4,data5,name1,sampleData:data,rate5,rate4,rate3,rate2,rate1
                                  });  
                              } else {
                                  console.log('Failed to retrieve the Course List: ');
                              }
                          }).sort(sort); 
                 
              
   }
   catch(err){
       return res.status(400).json({err})
   }
       }else{
         res.render("invalid1")
      }
   }catch{
      res.send("error")
   }
   })  ; 

 //adminlogin page

 router.post("/adminlogin",async function(req,res){ 
   console.log(req.body);  
   try{ 
     
      const check=await loginadmin.findOne({
       email:req.body.email
      }) 

      
      if(check){
         
      if(check.password===req.body.password){
         var data1;
         var data2;
         var data3;
         var data4;
         var data5=check.name;
         
         try{
             //first query
             let user_data = await loginadmin.count({}).exec();
             data1 = user_data;
      
             //second query
             let content_data = await loginstudent.count({}).exec();
             data3 = content_data;
       
             let content1_data = await doctordetails.count({}).exec();
             data2 = content1_data;
             let user_data2 = await collection.count({}).exec();
             data4 = user_data2;
           
            
              
             let five= await rating.count({star:5}).exec();
             rate5 = five;
             let four= await rating.count({star:4}).exec();
             rate4 = four;
             let three = await rating.count({star:3}).exec();
             rate3 = three;
             let two  = await rating.count({star:2}).exec();
             rate2 = two;
             let one = await rating.count({star:1}).exec();
             rate1 = one;
      
           
                        var sort = { rating : -1 };
                        doctorrating.find((err, data) => {
                              if (!err) {
                                 res.render("admindashboard", {
                                    data1,data2,data3,data4,data5,sampleData:data,rate5,rate4,rate3,rate2,rate1
                                  });  
                              } else {
                                  console.log('Failed to retrieve the Course List: ');
                              }
                          }).sort(sort); 
              
   }
   catch(err){
       return res.status(400).json({err})
   }
      }else{
         res.render("invalid1")
      } }else{
         res.render("invalid1")
      }
   }catch{
      res.send("error")
   }
})  

//student login page

router.post("/studentlogin",async function(req,res){ 
  
   try{ 
      // console.log(req.body);  
      const check=await loginstudent.findOne({
       email:req.body.email
      }) 
      
      if(check){
       
      if(check.password===req.body.password){
         var data1;
         var data2;
         var data3;
         var data4;
         var data5=check.name;
         try{
             //first query
             let user_data = await loginadmin.count({}).exec();
             data1 = user_data;
      
             //second query
             let content_data = await loginstudent.count({}).exec();
             data3 = content_data;
       
             let content1_data = await doctordetails.count({}).exec();
             data2 = content1_data;
             let user_data2 = await collection.count({}).exec();
             data4 = user_data2;
      
             let five= await rating.count({star:5}).exec();
             rate5 = five;
             let four= await rating.count({star:4}).exec();
             rate4 = four;
             let three = await rating.count({star:3}).exec();
             rate3 = three;
             let two  = await rating.count({star:2}).exec();
             rate2 = two;
             let one = await rating.count({star:1}).exec();
             rate1 = one;
                        var sort = { rating : -1 };
                        doctorrating.find((err, data) => {
                              if (!err) {
                                 res.render("studentdashboard", {
                                    data1,data2,data3,data4,data5,sampleData:data,rate5,rate4,rate3,rate2,rate1
                                  }); 
                              } else {
                                  console.log('Failed to retrieve the Course List: ');
                              }
                          }).sort(sort); 
                       
                    
         }
         catch(err){
             return res.status(400).json({err})
         }
      }else{
         res.render("invalid2")
      } }else{
         res.render("invalid2")
      }
   }catch{
      res.send("error")
   }
})  

//student login page

router.post("/doctorlogin",async function(req,res){ 
  
   try{ 
      // console.log(req.body);  
      const check=await logindoctor.findOne({
       email:req.body.email
      }) 
      
      if(check){
       
      if(check.password===req.body.password){
         var data1;
         var data2;
         var data3;
         var data4;
         var data5=check.name;
         var name1=check._id;
         try{
             //first query
             let user_data = await loginadmin.count({}).exec();
             data1 = user_data;
      
             //second query
             let content_data = await loginstudent.count({}).exec();
             data3 = content_data;
       
             let content1_data = await doctordetails.count({}).exec();
             data2 = content1_data;
             let user_data2 = await collection.count({}).exec();
             data4 = user_data2;
              
            //  res.render("doctordashboard", {
            //               data1,data2,data3,data4,data5,name1
            //             }); 
            let five= await rating.count({star:5}).exec();
            rate5 = five;
            let four= await rating.count({star:4}).exec();
            rate4 = four;
            let three = await rating.count({star:3}).exec();
            rate3 = three;
            let two  = await rating.count({star:2}).exec();
            rate2 = two;
            let one = await rating.count({star:1}).exec();
            rate1 = one;
            var sort = { rating : -1 };
                     doctorrating.find((err, data) => {
                           if (!err) {
                               res.render("doctordashboard", {
                                  sampleData:data,data5,data4,data3,data1,data2,name1,rate5,rate4,rate3,rate2,rate1
                               });
                           } else {
                               console.log('Failed to retrieve the Course List: ');
                           }
                       }).sort(sort); 
                    
         }
         catch(err){
             return res.status(400).json({err})
         }
      }else{
         res.render("invalid3")
      } }else{
         res.render("invalid3")
      }
   }catch{
      res.send("error")
   }
}) 


// router.get("/doctors",function(req,res,next) {
//    res.render("appointment");
// });  

//doctordetails
router.get('/doctorsa/:id', (req, res)=> {
      var data5=req.params.id;
   doctordetails.find((err, data) => {
       if (!err) {
           res.render("list1a", {
              sampleData:data,data5
           });
       } else {
           console.log('Failed to retrieve the Course List: ');
       }
   });   
});
router.get('/doctors/:id', (req, res)=> {
   var data5=req.params.id;
   doctordetails.find((err, data) => {
       if (!err) {
           res.render("list1", {
              sampleData:data,data5
           });
       } else {
           console.log('Failed to retrieve the Course List: ');
       }
   });   
});
router.get('/doctorsd/:id', (req, res)=> {
   var data5=req.params.id;
   doctordetails.find((err, data) => {
       if (!err) {
           res.render("list1d", {
              sampleData:data,data5
           });
       } else {
           console.log('Failed to retrieve the Course List: ');
       }
   });   
});
   
   router.get('/timingsadmin/:id', (req, res)=> {
      var data5=req.params.id;
      doctordetails.find((err, data) => {
         if (!err) {
          note.find((err, data1) => {
             if (!err) {
                 res.render("list2admin", {
                    sampleData:data,sampleData1:data1,data5
                 });
             } else {
                 console.log('Failed to retrieve the Course List: ');
             }
         });  
            
         } else {
             console.log('Failed to retrieve the Course List: ');
         }
     });  
   });
   router.get('/timings/:id', (req, res)=> {
      var data5=req.params.id;
      doctordetails.find((err, data) => {
         if (!err) {
          note.find((err, data1) => {
             if (!err) {
                 res.render("list2", {
                    sampleData:data,sampleData1:data1,data5
                 });
             } else {
                 console.log('Failed to retrieve the Course List: ');
             }
         });  
            
         } else {
             console.log('Failed to retrieve the Course List: ');
         }
     });   
    });
    router.get('/timingsd/:id', (req, res)=> {
      var data5=req.params.id;
      doctordetails.find((err, data) => {
         if (!err) {
          note.find((err, data1) => {
             if (!err) {
                 res.render("list2d", {
                    sampleData:data,sampleData1:data1,data5
                 });
             } else {
                 console.log('Failed to retrieve the Course List: ');
             }
         });  
            
         } else {
             console.log('Failed to retrieve the Course List: ');
         }
     });   
    });
   router.get('/visitors/:id', (req, res)=> {
      var data5=req.params.id;
      visitors.find((err, data) => {
           if (!err) {
               res.render("list3", {
                  sampleData:data,data5
               });
           } else {
               console.log('Failed to retrieve the Course List: ');
           }
       });  
    });
    router.get('/visitorsd/:id', (req, res)=> {
      var data5=req.params.id;
      visitors.find((err, data) => {
           if (!err) {
               res.render("list3d", {
                  sampleData:data,data5
               });
           } else {
               console.log('Failed to retrieve the Course List: ');
           }
       });  
    });
    router.get('/visitors1/:id', (req, res)=> {
      var data5=req.params.id;
      visitors.find((err, data) => {
           if (!err) {
               res.render("list4", {
                  sampleData:data,data5
               });
           } else {
               console.log('Failed to retrieve the Course List: ');
           }
       });  
    });
    //appointmentsdisplay
    router.get('/aps/:id', (req, res)=> {
      var data5=req.params.id;
      var sort = { date : 1 };
     collection.find({sheduledtime:"not yet sheduled"},(err, data) => {
           if (!err) {
               res.render("list5", {
                  sampleData:data,data5
               });
           } else {
               console.log('Failed to retrieve the Course List: ');
           }
       }).sort(sort);  
    });
    router.get('/deletevisitor/:id/:id1', (req, res, next)=> {
     var data5=req.params.id1;
      visitors.findByIdAndDelete({_id: req.params.id},(err, data) => { 
           
           if (!err) { 
               res.render("visitordelete",{data5});
           } else {
               console.log('Failed to delete: ');
               next(err);
           }
       });  
    });
    router.get('/deletedoctor/:id/:id1', (req, res, next)=> {
      var data5=req.params.id1;
       doctordetails.findByIdAndDelete({_id: req.params.id},(err, data) => { 
            
            if (!err) { 
                res.render("doctordelete",{data5});
            } else { 
                console.log('Failed to delete: ');
                next(err);
            }
        });  
     });
    
    //delete patient
    router.get('/deletepatient/:id/:id1', async(req, res, next)=> {
     var data5=req.params.id1;
    
     
    
      collection.findByIdAndDelete({_id: req.params.id},(err, data) => { 
           
           if (!err) {
               res.render("deletesuccess",{data5});
           } else {
               console.log('Failed to delete: ');
               next(err);
           }
       });  
    });


    //
    router.get('/deletepatientbydoctor/:id/:id1/:id2', async(req, res, next)=> {
      var data5=req.params.id;
      var name1=req.params.id2;
        
       collection.findByIdAndDelete({_id: req.params.id1},(err, data) => { 
            
            if (!err) { 
                res.render("deletesuccessbydoctor",{data5,name1});
            } else {
                console.log('Failed to delete: ');
                next(err);
            }
        });  
     });

    //accept patient
    router.post('/accepts/:id/:id1',async (req, res, next)=> {
      var data5=req.params.id1;
      collection.findByIdAndUpdate({_id: req.params.id},req.body,(err, data) => { 
           
         if (!err) {
             res.render("acceptsuccess",{data5});
         } else {
             console.log('Failed to update: ');
             next(err);
         }
     });  
            
    });
  

    router.get('/acceptpage/:id/:id1',async(req, res, next)=> {
                var name1=req.params.id;
                var data5=req.params.id1;
                
                doctordetails.find((err, data) => {
                  if (!err) {
                     res.render("accept",{name1,data5,
                     sampleData:data});
                  } else {
                      console.log('Failed to retrieve the Course List: ');
                  }
              });   

           
         
            
    }); 
    router.get('/prescribe/:id/:id1/:id2',async(req, res, next)=> {
      var data5=req.params.id;
      var name1=req.params.id1;
      var name3=req.params.id2;
      
      res.render("prescription",{name1,data5,name3}); 


 

  
});  
router.post('/prescribe/:id/:id1/:id2',async (req, res, next)=> {
   var data5=req.params.id;
   var name1=req.params.id1;
   var name3=req.params.id2;
   collection.findByIdAndUpdate({_id: req.params.id1},req.body,async(err, data) => { 
        
      if (!err) {  
         let transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: 'gfg882004@gmail.com', // host email address
                 pass: process.env.SMTP_PASS,
      
      
            },
        });
      
        // send mail with defined transport object
        let info = await transporter.sendMail({
            from: '"Health center" <gfg882004@gmail.com>', // sender address
            to: data.email, // list of receivers email Id's
            subject: "Health center Appointment prescription " , // Subject line
            text: "Congratulations"+data.name+"Your Appointment has been scheduled succesfully,Please find the receipt below. Please visit the iit indore official health website for further updates." , // plain text body
            html:`<table><tbody><tr><td></td><td ><div > <table><tbody><tr><td  ><tbody><tr><td ><h2>Your Appointment has been prescribed by the Doctor please find the  prescription below: </h2> </td></tr><tr><td ><table > <tbody><tr><td><table ><tbody><tr><td>Patient Name</td><td >${data.name}</td> </tr><tr><td>Email</td><td >${data.email}</td> </tr><tr> <td>Phone Number</td><td >${data.phone}</td></tr><tr > <td >Age</td> <td >${data.age}</td> </tr><tr ><td >Symptoms</td><td >${data.symptoms}</td> </tr><tr ><td >Sheduled Time</td><td >${data.sheduledtime}</td></tr><tr ><td >Assigned Doctor</td> <td >${data.assigneddoctor}</td> </tr> <tr ><td >Test prescribed</td><td >${req.body.test}</td> </tr><tr ><td >Medicine prescribed:</td> <td >${req.body.medicine}</td></tr> <tr ><td >Advise of doctor:</td><td >${req.body.advise}</td></tr> </tbody></table></td></tr></tbody></table> </td></tr></tbody></table> </td></tr></tbody></table><div ><tbody> </tbody></table> </div></div></td><td></td></tr></tbody></table>`
        });
      
        console.log("Message sent: %s", info.messageId);
          res.render("prescribedsuccess",{data5,name1,name3});
      } else {
          console.log('Failed to update: ');
          next(err);
      }
  });   
         
 });

   
    router.post("/adddoctor/:id",async(req,res)=>{
      var name1=req.params.id;
     
      const data={
         name:req.body.name,
         email:req.body.email,
         qualification:req.body.qualification,
         specialization:req.body.specialization,
         available:req.body.available,
        timings:req.body.timings1+" - "+req.body.timings2,
         type:req.body.type
   
      } 
      const data1={
         email:req.body.email,
         password:req.body.phone,
         name:req.body.name
      }  


      let transporter = nodemailer.createTransport({
         host: "smtp.gmail.com",
         port: 587,
         secure: false, // true for 465, false for other ports
         auth: {
             user: 'gfg882004@gmail.com', // host email address
             pass: process.env.SMTP_PASS,
   
   
         },
     });
   
     // send mail with defined transport object
     let info = await transporter.sendMail({
         from: '"Health center" <gfg882004@gmail.com>', // sender address
         to: req.body.email, // list of receivers email Id's
      subject: "Welcome to Health center community" , // Subject line
         text: "Welcome Doctor "+req.body.name+" to the IIT INDORE health center community Hope Your services makes smile on everyones face. For further information please contact us as gfg882004@gmail.com" , // plain text body
     });
   
     console.log("Message sent: %s", info.messageId);







      if( req.body.type=="visitor"){
      
      await visitors.insertMany([data])
      await logindoctor.insertMany([data1])
      res.render("success1",{name1});
    
   
   }
      else{
         await doctordetails.insertMany([data])
         await logindoctor.insertMany([data1])
         res.render("success1",{name1});
      }
   })


// router.get('/admincount', (req, res)=> {
    
   
//  loginadmin.count((err, data) => {
//       if (!err) { 
//          res.render("list2", {
//           data
//          }); 
        
//       } else {
//           console.log('Failed to retrieve the count: ');
//       }
//   });  
  
   

// });  
router.get('/admincount', async function(req, res) {
   var data1;
   var data2;
   var data3;
   try{
       //first query
       let user_data = await loginadmin.count({}).exec();
       data1 = user_data;

       //second query
       let content_data = await loginstudent.count({}).exec();
       data2 = content_data;
 
       let content1_data = await logindoctor.count({}).exec();
       data3 = content1_data;
       res.render("list2", {
                    data1,data2,data3
                  }); 
                 
              
   }
   catch(err){
       return res.status(400).json({err})
   } 
}); 
//appointment form

router.post("/appointmentss/:id",async(req,res)=>{
   var name1=req.params.id;
   let date_time = new Date();
   let datenow = ("0" + date_time.getDate()).slice(-2);

// get current month
let month = ("0" + (date_time.getMonth() + 1)).slice(-2);

// get current year
let year = date_time.getFullYear();
let hours = date_time.getHours();

// get current minutes
let minutes = date_time.getMinutes();

// get current seconds
let seconds = date_time.getSeconds();
   const data={
      name:req.body.name,
      email:req.body.email,
      phone:req.body.phone,
      date:year+"-"+month+"-"+datenow+" time "+hours + ":" + minutes,
      age:req.body.age,
      symptoms:req.body.symptoms,
      days:req.body.days,
      sheduledtime:"not yet sheduled",
      assigneddoctor:"Not Yet Assigned",
      test:"--",
      medicine:"--",
      advise:"--",
     
   }     
   
   let transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
          user: 'gfg882004@gmail.com', // host email address
           pass: process.env.SMTP_PASS,


      },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
      from: '"Health center" <gfg882004@gmail.com>', // sender address
      to: req.body.email, // list of receivers email Id's
      subject: "Health center Appointment status" , // Subject line
      text: "Congratulations "+req.body.name+" Your Appointment has been booked successfully,We will contact you soon with the Appointment sheduling time and sheduled doctor. Please visit the iit indore official health website for further updates  For further information please contact us as gfg882004@gmail.com" , // plain text body
  });

  console.log("Message sent: %s", info.messageId);


   var n=req.body.name;
   await collection.insertMany([data])
   res.render("success",{name1,n});
})
router.post("/appointmentsd/:id",async(req,res)=>{
   var name1=req.params.id;
   let date_time = new Date();
   let datenow = ("0" + date_time.getDate()).slice(-2);

// get current month
let month = ("0" + (date_time.getMonth() + 1)).slice(-2);

// get current year
let year = date_time.getFullYear();
let hours = date_time.getHours();

// get current minutes
let minutes = date_time.getMinutes();

// get current seconds
let seconds = date_time.getSeconds();
   const data={
      name:req.body.name,
      email:req.body.email,
      phone:req.body.phone,
      date:year+"-"+month+"-"+datenow+" time "+hours + ":" + minutes,
      age:req.body.age,
      symptoms:req.body.symptoms,
      days:req.body.days,
      sheduledtime:"not yet sheduled",
      assigneddoctor:"Not Yet Assigned",
      test:"--",
      medicine:"--",
      advise:"--",
      
   }  
   let transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
          user: 'gfg882004@gmail.com', // host email address
           pass: process.env.SMTP_PASS,


      },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
      from: '"Health center" <gfg882004@gmail.com>', // sender address
      to: req.body.email, // list of receivers email Id's
      subject: "Health center Appointment status" , // Subject line
      text: "Congratulations "+req.body.name+" Your Appointment has been booked successfully,We will contact you soon with the Appointment sheduling time and sheduled doctor. Please visit the iit indore official health website for further updates  For further information please contact us as gfg882004@gmail.com" , // plain text body
  });

  console.log("Message sent: %s", info.messageId);
   var n=req.body.name;
   await collection.insertMany([data])
   res.render("successd",{name1,n});
})
router.post("/appointmentsa/:id",async(req,res)=>{
   var name1=req.params.id;
   let date_time = new Date();
   let datenow = ("0" + date_time.getDate()).slice(-2);

// get current month
let month = ("0" + (date_time.getMonth() + 1)).slice(-2);

// get current year
let year = date_time.getFullYear();
let hours = date_time.getHours();

// get current minutes
let minutes = date_time.getMinutes();

// get current seconds
let seconds = date_time.getSeconds();
   const data={
      name:req.body.name,
      email:req.body.email,
      phone:req.body.phone,
      date:year+"-"+month+"-"+datenow+" time "+hours + ":" + minutes,
      age:req.body.age,
      symptoms:req.body.symptoms,
      days:req.body.days,
      sheduledtime:"not yet sheduled",
      assigneddoctor:"Not Yet Assigned",
      test:"--",
      medicine:"--",
      advise:"--",
      
   }  
   let transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
          user: 'gfg882004@gmail.com', // host email address
           pass: process.env.SMTP_PASS,


      },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
      from: '"Health center" <gfg882004@gmail.com>', // sender address
      to: req.body.email, // list of receivers email Id's
      subject: "Health center Appointment status" , // Subject line
      text: "Congratulations "+req.body.name+"Your Appointment has been booked successfully,We will contact you soon with the Appointment sheduling time and sheduled doctor. Please visit the iit indore official health website for further updates  For further information please contact us as gfg882004@gmail.com" , // plain text body
  });

  console.log("Message sent: %s", info.messageId);
   var n=req.body.name;
   await collection.insertMany([data])
   res.render("successa",{name1,n});
})
//displaydoctorappointmenst
router.get('/displayappointments/:id/:id1', async(req, res, next)=> {
   var sort = { date : 1 };
   var name1=await logindoctor.findOne({_id: req.params.id});
   var name3=req.params.id;
    var name2=name1.name;
    var data5=req.params.id1;
  
    
   collection.find({assigneddoctor:name2,test:"--"},(err, data) => { 
     
        if (!err) { 
            res.render("list6",{sampleData:data,data5,name3});
        } else {
            console.log('Failed to delete: ');
            next(err);
        }
    }).sort(sort);  
 });
router.post("/note/:id",async function(req,res){
   const data={
      note:req.body.note
    }
    
    await note.deleteMany({});
   await note.insertMany([data]);
   const check=await note.findOne({}); 
   var data5=req.params.id; 
   
   let transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
          user: 'gfg882004@gmail.com', // host email address
           pass: process.env.SMTP_PASS,


      },
  });

  // send mail with defined transport object
  let info = await transporter.sendMail({
      from: '"Health center" <gfg882004@gmail.com>', // sender address
      to: "cse210001063@iiti.ac.in,cse210001075@iiti.ac.in", // list of receivers email Id's
      subject: "Health center timings updates " , // Subject line
      text: "Today updates in health center timings  as follows: " +" "+ check.note +" For further information please contact us as gfg882004@gmail.com" , // plain text body
  });

  console.log("Message sent: %s", info.messageId);
  
   
      res.render("mailedsuccessfully",{data5});
//    doctordetails.find((err, data) => {
//       if (!err) {
//        note.find((err, data1) => {
//           if (!err) { 
             
//               res.render("list2admin", {
//                  sampleData:data,sampleData1:data1,data5
//               });
//           } else {
//               console.log('Failed to retrieve the Course List: ');
//           }
//       });  
         
//       } else {
//           console.log('Failed to retrieve the Course List: ');
//       }
//   });   
 
   
}) 
// router.get("/mail",function(req,res,next){
//   res.render("mailedsuccessfully");
  
 
   
// })  


//appointment details
router.get("/statuss/:id/:id1/:id2/:id3",async function(req,res){ 
    var name1=req.params.id;
    var e=req.params.id1;
    var p=req.params.id2;
   try{ 
       
      const check=await collection.findOne({
       _id:req.params.id3
      }) 
      
      if(check){
       
    
         var data1=check.name;
         var data2=check.email;
         var data3=check.phone;
         var data4=check.age;
         var data5=check.symptoms;
         var data6=check.sheduledtime;
         var data7=check.assigneddoctor;
         var data8=check.test;
         var data9=check.medicine;
         var data10=check.advise;
         
       

         // try{
         //     //first query
         //     let user_data = await loginadmin.count({}).exec();
         //     data1 = user_data;
      
         //     //second query
         //     let content_data = await loginstudent.count({}).exec();
         //     data3 = content_data;
       
         //     let content1_data = await doctordetails.count({}).exec();
         //     data2 = content1_data;
         //     let user_data2 = await collection.count({}).exec();
         //     data4 = user_data2;
                
             res.render("display",{data1,data2,data3,data4,data5,data6,data7,name1,data8,data9,data10,e,p}); 
                   
                    
         
        
      
    }else{
      res.render("invalid4",{name1})
    }
     
   }
   catch{
      res.send("error")
   }
})  
router.get("/statussd/:id/:id1/:id2/:id3",async function(req,res){ 
   var name1=req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
  try{ 
      
     const check=await collection.findOne({
      _id:req.params.id3
     }) 
     
     if(check){
      
     
        var data1=check.name;
        var data2=check.email;
        var data3=check.phone;
        var data4=check.age;
        var data5=check.symptoms;
        var data6=check.sheduledtime;
        var data7=check.assigneddoctor;
        var data8=check.test;
        var data9=check.medicine;
        var data10=check.advise;
        
      

        // try{
        //     //first query
        //     let user_data = await loginadmin.count({}).exec();
        //     data1 = user_data;
     
        //     //second query
        //     let content_data = await loginstudent.count({}).exec();
        //     data3 = content_data;
      
        //     let content1_data = await doctordetails.count({}).exec();
        //     data2 = content1_data;
        //     let user_data2 = await collection.count({}).exec();
        //     data4 = user_data2;
               
            res.render("displayd",{data1,data2,data3,data4,data5,data6,data7,name1,data8,data9,data10,e,p}); 
                  
                   
        
       
     
   }else{
     res.render("invalid4d",{name1})
   }
    
  }
  catch{
     res.send("error")
  }
}) 
//doctoradd
//img
router.post("/appointmenttt",async(req,res)=>{
   var name1=req.params.id;
   const data={
      name:req.body.name,
      email:req.body.email,
      phone:req.body.phone,
      date:req.body.date+' time '+req.body.time,
      age:req.body.age,
      symptoms:req.body.symptoms,
      days:req.body.days,
      sheduledtime:"not yet sheduled",
      assigneddoctor:"Not Yet Assigned",
      test:"--",
      medicine:"--",
      advise:"--",

     
     
   } 
   await collection.insertMany([data])
   res.render("success",{name1});
})
//
router.get("/historys/:id", function(req,res,next) {
   var data5=req.params.id;
   res.render("status1s",{data5});
});
router.post("/historyss/:id",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
      
  collection.find({email:req.body.email,phone:req.body.phone},(err, data) => { 
   var e=req.body.email;
   var p=req.body.phone;
      if (!err) { 
          res.render("list7s",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  

router.get("/list7s/:id/:id1/:id2",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
   var e=req.params.id1;
   var p=req.params.id2;
  collection.find({email:req.params.id1,phone:req.params.id2},(err, data) => { 
  
      if (!err) { 
          res.render("list7s",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  
//
router.get("/historya/:id", function(req,res,next) {
   var data5=req.params.id;
   res.render("status1a",{data5});
});
router.post("/historysa/:id",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
   var e=req.body.email;
   var p=req.body.phone;
  collection.find({email:req.body.email,phone:req.body.phone},(err, data) => { 
         
      if (!err) { 
          res.render("list7",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  
router.get("/list7/:id/:id1/:id2",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
   var e=req.params.id1;
   var p=req.params.id2;
  collection.find({email:req.params.id1,phone:req.params.id2},(err, data) => { 
  
      if (!err) { 
          res.render("list7",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  
//
router.get("/historyd/:id", function(req,res,next) {
   var data5=req.params.id;
   res.render("status1d",{data5});
});
router.post("/historysd/:id",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
      var e=req.body.email;
      var p=req.body.phone;
  collection.find({email:req.body.email,phone:req.body.phone},(err, data) => { 
         
      if (!err) { 
          res.render("list7d",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  
router.get("/list7d/:id/:id1/:id2",async function(req,res,next){ 
   var data5=req.params.id;
   var sort = { date : 1 };
   var e=req.params.id1;
   var p=req.params.id2;
  collection.find({email:req.params.id1,phone:req.params.id2},(err, data) => { 
   
      if (!err) { 
          res.render("list7d",{sampleData:data,data5,e,p});
      } else {
          console.log('Failed to delete: ');
          next(err);
      }
  }).sort(sort);  
})  
//feeedback
router.post("/feedback/:id/:id1/:id2/:doctor",async(req,res)=>{
   var data5=req.params.id;
   
   var e=req.params.id1;
   var p=req.params.id2;
   const data={
      star:req.body.rate,
      description:req.body.feedback,
      star1:req.body.rate1,
      doctorfeedback:req.body.doctorfeedback,
      doctorname:req.params.doctor

   } 
   const data1={
      name:req.params.doctor,
      rating:req.body.rate1
   }  
   const check=await doctorrating.findOne({
      name:req.params.doctor
     }) 
     if(check){
      var newvalues = { rating:  req.body.rate1 };

      if(req.body.rate1>check.rating){
    
      doctorrating.updateMany({name: req.params.doctor},newvalues,(err, data2) => { 
            
         console.log(newvalues);
         console.log('navya');
         
        
     });  
   }
          
         
  
     }else{
      await doctorrating.insertMany([data1])
     }
      
   await rating.insertMany([data])

   res.render("successra",{data5,e,p});

})
router.post("/feedbacks/:id/:id1/:id2/:doctor",async(req,res)=>{
   var data5=req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
   const data={
      star:req.body.rate,
      description:req.body.feedback,
      star1:req.body.rate1,
      doctorfeedback:req.body.doctorfeedback,
      doctorname:req.params.doctor
     

   } 
 
   await rating.insertMany([data])
   res.render("successr",{data5,e,p});

})
router.post("/feedbackd/:id/:id1/:id2/:doctor",async(req,res)=>{
   var data5=req.params.id;
   var e=req.params.id1;
   var p=req.params.id2;
   const data={
      star:req.body.rate,
      description:req.body.feedback,
      star1:req.body.rate1,
      doctorfeedback:req.body.doctorfeedback,
      doctorname:req.params.doctor
     

   } 
 
   await rating.insertMany([data])
   res.render("successrd",{data5,e,p});

}) 
router.get('/review/:id', (req, res)=> {
   var data5=req.params.id;
   
  rating.find((err, data) => {
        if (!err) {
            res.render("displayfeedback", {
               sampleData:data,data5
            });
        } else {
            console.log('Failed to retrieve the Rating List: ');
        }
    });  
 });
 router.get('/reviews/:id', (req, res)=> {
   var data5=req.params.id;
   
  rating.find((err, data) => {
        if (!err) {
            res.render("displayfeedbacks", {
               sampleData:data,data5
            });
        } else {
            console.log('Failed to retrieve the Rating List: ');
        }
    });  
 });
 router.get('/reviewd/:id', (req, res)=> {
   var data5=req.params.id;
   
  rating.find((err, data) => {
        if (!err) {
            res.render("displayfeedbackd", {
               sampleData:data,data5
            });
        } else {
            console.log('Failed to retrieve the Rating List: ');
        }
    });  
 });
 router.post("/addblood/:id",async(req,res)=>{
   var data5=req.params.id;
  
   const data={
      name:req.body.name,
      email:req.body.email,
      
      group:req.body.group

   } 
  
   
   await blood.insertMany([data])
   res.render("successblood",{data5});
 


});
router.post("/addbloods/:id",async(req,res)=>{
   var data5=req.params.id;
  
   const data={
      name:req.body.name,
      email:req.body.email,
      
      group:req.body.group

   } 
  
   
   await blood.insertMany([data])
   res.render("successbloods",{data5});
 


});
router.post("/addbloodd/:id",async(req,res)=>{
   var data5=req.params.id;
  
   const data={
      name:req.body.name,
      email:req.body.email,
      
      group:req.body.group

   } 
  
   
   await blood.insertMany([data])
   res.render("successbloodd",{data5});
 


});

module.exports=router;


 
