# What Can We Play Today
# Team Project: Yukio, Warren, Luis, Jennah

What Can We Play Today is a web application that helps you and your friends find common games you all own on Steam. The application uses the Steam API to fetch user game data and then compares the games owned by each user in a room to generate a list of shared games.

## Features

- **User Authentication**: Log in using your Steam account.
- **Room Creation and Joining**: Create a room and share the room number with your friends. They can join the room using this number.
- **Shared Game List Generation**: Once you and your friends are in the same room, the application will generate a list of games that all of you own.
- **Real-time Communication**: The application uses Socket.IO to enable real-time communication between the server and the client. This is used to update the list of users in a room and the list of shared games.

## How to Use

1. Clone the repository.
2. Install the dependencies using `npm install`.
3. Start the server using `node index.js`.
4. Open your web browser and navigate to `http://localhost:3000`.
5. Log in using your Steam account.
6. Create a room and share the room number with your friends.
7. Once everyone has joined the room, click on "Generate List" to get a list of shared games.

## Dependencies

- Express.js
- Socket.IO
- node-steam-openid
- steam-js-api
- SQLite3
