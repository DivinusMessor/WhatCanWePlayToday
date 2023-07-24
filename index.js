// Critical for Express itself
const express = require("express");
const app = express();
const cookieParser = require("cookie-parser");
app.use(cookieParser());
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const axios = require("axios");

const server = require("http").createServer(app);
// TODO: Double check what CORS policy will mean for our app.
const io = require("socket.io")(server, { cors: { origin: "*" } });
// Ensure API Keys and Confidential Data don't get published to Github
const config = require("./private/keys.json");
// Setting up a helper Wrapper library to make the Steam API much easier to use
const steamWrapper = require("steam-js-api");
steamWrapper.setKey(config.steamKey);

// Necessary for Steam Oauth
const SteamAuth = require("node-steam-openid");
// Setup for Steam Oauth
const steam = new SteamAuth({
  // TODO: Eventually this will be set to the proper Domain name.
  realm: config.url,
  returnUrl: config.url + "/auth/steam/authenticate",
  apiKey: config.steamKey,
});

// Setup for keeping track of Users temporary data.
const session = require("express-session");
const { types } = require("util");
const { parse } = require("path");
app.use(
  session({
    secret: config.sessionSecret,
    resave: true,
    saveUninitialized: true,
  }),
  bodyParser.urlencoded({ extended: true }),
  bodyParser.json({ extended: true })
);

// Tell Express which Templating Engine we're using
app.set("view engine", "ejs");
// Specify the Folder for Statics
app.use(express.static("public"));
// Need this line to allow Express to parse values sent by POST forms
app.use(express.urlencoded({ extended: true }));

// Setup and Connect a SQLite3 Database for Room/User data storage.
const sqlite3 = require("sqlite3").verbose();
let databaseFilePath = `./private/games.db`;
let database = new sqlite3.Database(
  databaseFilePath,
  sqlite3.OPEN_READWRITE,
  (_) => {
    console.log("Connected to database!");
  }
);

// TODO: Consolidate the two room structs (this & socketRooms) so we don't use extra memory.
let existingRooms = [];

// corresponds to page.com
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy");
});

// Redirects user to steam login page
app.get("/auth/steam", async (req, res) => {
  const redirectUrl = await steam.getRedirectUrl();
  return res.redirect(redirectUrl);
});

// Gets user information and renders the rooms page
app.get("/auth/steam/authenticate", async (req, res) => {
  try {
    const user = await steam.authenticate(req);
    // DEBUG: Confirm the Users account details.
    // console.log(user);

    // TODO: Check that this cookie storage method is best practices.
    res.cookie("steamID", user["steamid"]);
    res.cookie("username", user["username"]);
    res.cookie("avatar", user["avatar"]["medium"]);

    // DEBUG: Checking who is logged in via Backend
    console.log(`${user["username"]} has logged in!`);

    res.render("room-choice");
  } catch (error) {
    console.error(`ERROR: Couldn't Fetch! ${error}`);
  }
});

//Used in case users want to login through their steam id
app.get("/alt-login", (req, res) => {
  res.render("alt-login");
});

// Users get shown the CREATE or JOIN room buttons. Here they'll start the process of generating a Room Number and allowing others to join them.
app.get("/room-choice", (req, res) => {
  res.render("room-choice");
});

//Passes host role
app.post("/room-choice", async (req, res) => {
  let roomNumber = Math.floor(Math.random() * 90000) + 10000;
  roomNumber = roomNumber.toString();
  // Ensures that room numbers are random and unique so we don't have colliding room IDs.
  while (existingRooms.includes(roomNumber)) {
    roomNumber = Math.floor(Math.random() * 90000) + 10000;
    roomNumber = roomNumber.toString();
  }

  // Add our now guaranteed unique room to the existing rooms & also add the number to the users cookies.
  existingRooms.push(roomNumber);
  res.cookie("roomNumber", roomNumber);

  // Render the next page for the Host now with the number on their page.
  res.redirect(
    "empty-room",
    {
      role: req.body.role,
      roomNumber: this.roomNumber,
      url: config.url,
    },
    303
  );
});

app.get("/join-room", async (req, res) => {
  res.render("join-room", { existingRooms: existingRooms });
});

app.post("/join-room", (req, res) => {
  let potentialRoomNum = req.body.roomnum;
  // DEBUG: Check the incoming data and the struct it's being compared to
  // console.log(`${potentialRoomNum}`);
  // console.log(existingRooms);
  if (existingRooms.includes(potentialRoomNum)) {
    console.log(`Room FOUND`);
    res.cookie("roomNumber", potentialRoomNum);
    res.render("empty-room", { roomNumber: potentialRoomNum, url: config.url });
  } else {
    console.log(`Room NOT FOUND`);
    res.render("join-room", { existingRooms: existingRooms });
  }
});

// TODO: Ensure that regardless of the proper routing, that all pages validate and ensure they have the data they need (e.g. empty-room will redirect the users to create/join room if they DONT have a Room Number in their cookies).
app.get("/empty-room", (req, res) => {
  // console.log(req.cookies);
  res.render("empty-room", {
    roomNumber: req.cookies.roomNumber,
    url: config.url,
  });
});

//Used for alt login
app.post("/alt-login", async (req, res) => {
  try {
    let steamID = req.body.userId;
    console.log("Getting user information...");
    const response = await axios.get(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${config.steamKey}&steamids=${steamID}`
    );
    //const players = response.data && response.data.response && response.data.response.players;
    let user = response.data.response.players;

    let username = user[0].personaname;
    let profileImg = user[0].avatarmedium;

    res.cookie("steamID", steamID);
    res.cookie("username", username);
    res.cookie("avatar", profileImg);
    res.redirect(303, "room-choice");
  } catch {
    console.log("Could not fetch information...");
  }
});

//Sockets used for members of the same room
function Room(roomNumber, roomMembers) {
  this.roomNumber = roomNumber;
  this.roomMembers = roomMembers;
}
let socketRooms = [];

//Socket.io used to room member data to the front end
io.on("connection", (socket) => {
  // Used to generate room with its members
  socket.on("message", (data) => {
    let roomNumber = data.roomNumber;
    socket.join("room-" + roomNumber);

    let potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);
    // Using the variable above, we can check if there IS a room or not
    if (typeof potentialRoom != "undefined") {
      // DEBUG: Checking our Logic
      console.log(`Found Room: ${roomNumber}`);
      let foundMembers = potentialRoom.roomMembers;
      // IF the USER is ALREADY there DONT update
      let hasFound = false;
      for (let i = 0; i < foundMembers.length; i++) {
        if (foundMembers[i][0] == data.steamID) {
          hasFound = true;
        }
      }

      if (hasFound == false) {
        foundMembers.push([data.steamID, data.username, data.avatar]);
        potentialRoom.roomMembers = foundMembers;
      }
    } else {
      // DEBUG: Checking our Logic
      console.log(`Room NOT Found: ${roomNumber}`);
      // Made a temp array to store the first user (HOST) and add to the array keeping track of existing socket rooms.
      let temp = new Room(roomNumber, [
        [data.steamID, data.username, data.avatar],
      ]);
      socketRooms.push(temp);
    }

    // Refind the room again and set the output of users to the front-end
    potentialRoom = socketRooms.find((x) => x.roomNumber === roomNumber);
    roomMembers = potentialRoom.roomMembers;

    io.sockets.in("room-" + roomNumber).emit("otherMsg", roomMembers);
  });

  socket.on("newList", (data) => {
    socket.join("room-" + data.roomNumber);
    io.sockets.in("room-" + data.roomNumber).emit("navigate");
  });

  // MAIN WORKHORSE FUNCTION. Gathers the SteamIDs of the room members and uses them to generate the massive list of shared games.
  // Sort by amount of time played and then generate shared list
  socket.on("generate", async (data) => {
    const roomNumber = data.roomNumber;
    const roomMembers = socketRooms.find(
      (x) => x.roomNumber === roomNumber
    ).roomMembers;
    // Arrays to be sent to the front-end later.
    let sharedGameNames = [];
    let ownedByWho = [];
    let gameImages = [];
    let gameLinks = [];
    let gameTags = []; // TODO: Add Tag functionality

    // First we'll iterate through EVERY room member. Goal is to run through each user and their games and "tick" off who owns what.
    for (let i = 0; i < roomMembers.length; i++) {
      // A users total game count & an array of their games. For iterating & that'll be set later.
      let gameInfo = [];
      let gameCount = 0;
      // aka their SteamID.
      const curMembersID = roomMembers[i][0];

      // An API function that will set gameCount and gameInfo to the total count of a users games and an array of their games respectively.
      await steamWrapper
        .getOwnedGames(curMembersID, null, true)
        .then((result) => {
          gameCount = result.data.count;
          gameInfo = result.data.games;
        })
        .catch(console.error);

      // Now we can iterate through the CURRENT USERS GAMES using the data from the above function.
      for (let curGame = 0; curGame < gameCount; curGame++) {
        const gameName = gameInfo[curGame].name;
        const gamePic = gameInfo[curGame].url_store_header;
        const gameURL = gameInfo[curGame].url_store;
        const gameID = gameInfo[curGame].appID;
        let tags = ``;
        let final_price = `Free`;
        let initial_price = `Free`;

        // TODO: Here is where we could filter out games before they're added into each users array.

        // FIRST we query our database to see if we HAVE the game there or not
        database.get(
          `SELECT * FROM Games WHERE gameID = ?`,
          gameID,
          async function (err, row) {
            if (err) return console.error(err.message);
            // Checking the result of our Query
            if (row) {
              // Game WAS found so we either retrieve the data OR if the data is past expiration we'll re-query it.
              
                // if ("game is a singleplayer game (check database col)") {
                //     // ignore the game entirely
                // } else if ("the game is past expiration") {
                //     // "re-fetch the data and update the query"
                // } else {
                //     // data is good so query from database & set all the variables to the result
                // }
                // TODO: In the case of a user with a large/niche library surpassing 200 calls we'll have to set things to null and then re-query possibly.
            } else {
              // Game was NOT found so we'll have to add it.

              function parseTags(inputTags) {
                return Object.keys(inputTags).join(",");
              }

              // First SteamSPY's API for the detailed tags of a game.
              const url = `https://steamspy.com/api.php?request=appdetails&appid=${gameID}`;
              const response = await fetch(url);
              const result = await response.json();
              tags = parseTags(result.tags);

              // Then Steam's API for majority of the data. From this we want the "categories" and pricing of each game.
              const steamURL = `https://store.steampowered.com/api/appdetails?appids=${gameID}&l=en`;
              const response2 = await fetch(steamURL);
              const result2 = await response2.json();

              // Getting the price of the games
              let priceOverview = result2[`${gameID}`].data.price_overview;
              if (!result2[`${gameID}`].data.is_free) {
                final_price = priceOverview.final_formatted; // final
                initial_price = priceOverview.initial_formatted; // initial
              }
              // Getting the "categories" of the game
              let descriptions = result2[`${gameID}`].data.categories.map(
                (category) => category.description
              );
              let genre = descriptions.join();

              // Age is self made independent of the APIs and meant to catalog the age of the record so if it passes a certain range it'll be re-queried.
              let age = `2023-07-20`;

              // Inserting into the database if it's not there
              database.run(
                `INSERT INTO Games (gameID, name, genre, tags, age, price, initial_price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  gameID,
                  gameName,
                  genre,
                  tags,
                  age,
                  final_price,
                  initial_price,
                ],
                function (err) {
                  if (err) {
                    return console.error(err.message);
                  }
                  console.log(`${gameName} has been inserted!`);
                }
              );
            }
            // AFTER the IF that adds the game to our database (or fetches it) will now have the proper data to be sent to the front-end.
            // Checking if the current game is in out checked list or not
            const indexOfGame = sharedGameNames.indexOf(gameName);
            // TODO: Would it be better to use a games ID here? Can a game have the same name as another?
            if (indexOfGame != -1) {
              // It IS THERE so curGame append the SteamID to the "current owners"
              ownedByWho[indexOfGame].push(i);
            } else {
              // it IS NOT there so make a new entry with name, image, & link
              sharedGameNames.push(gameName);
              gameImages.push(gamePic);
              gameLinks.push(gameURL);
              // Add the SteamID to a new array and start the appending process
              let temp = [];
              temp.push(i);
              ownedByWho.push(temp);
            }
          }
        );
      }
    }

    socket.join("room-" + roomNumber);
    io.sockets.in("room-" + roomNumber).emit("finalList", {
      roomMembers: roomMembers,
      games: sharedGameNames,
      owners: ownedByWho,
      images: gameImages,
      links: gameLinks,
    });
  });
});

app.get("/list", async (req, res) => {
  res.render("list", { url: config.url });
});

// DEBUG: For checking HTML elements on a safe page.
app.get("/test", async (req, res) => {
  res.render("test");
});

app.get("/altTest", async (req, res) => {
  res.render("altTest");
});

app.get("/logout", (req, res) => {
  res.clearCookie("steamID");
  res.clearCookie("username");
  res.clearCookie("avatar");
  res.clearCookie("roomNumber");

  res.render("index");
});

server.listen(3000, () => {
  console.log(`SocketIO Server has Started!`);
});
