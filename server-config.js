// Put here your email sending configurations!
module.exports = {
	emailTransport: {
		host: "smtp.gmail.com",
		port: 465,
		auth: {user: "studiocoma.be@gmail.com", pass: "Qf7g4tMtG3Q&"}
	},
	emailOptions: {
		from: "Carri <studiocoma.be@gmail.com>", // sender address
		bcc: "studiocoma.be@gmail.com",
	}
};
