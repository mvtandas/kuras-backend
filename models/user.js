const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: { type: String },
  surname: { type: String },
  gender: { type: String, enum: ['Erkek', 'Kadın']},
  birthDate: { type: Date},
  fatherName: { type: String},
  motherName: { type: String },
  city: { type: mongoose.Schema.Types.ObjectId, ref: "City"},
  club: { type: mongoose.Schema.Types.ObjectId, ref: "Club" },
  role: { type: mongoose.Schema.Types.ObjectId, ref: "Role"},
  sportStartDate: { type: Date },
  athleteLicenseNo: { type: String},
  email: { type: String, unique: true },
  password: { type: String, }, // Hashed password
  createdAt: { type: Date, default: Date.now },
  identityNumber: { type: String, unique: true },
  nationality: { type: String },
  serialNumber: { type: String },
  bloodType: { type: String },
  religion: { type: String },
  endDate: { type: Date },
  birthCity: { type: String },
  educationStatus: { type: String, enum: ['İlköğretim', 'Lise', 'Ön Lisans', 'Lisans', 'Yüksek Lisans', 'Doktora', '']},
  language: { type: String, enum: ['İngilizce', 'Almanca', 'İspanyolca', 'Fransızca', 'Arapça', '']},
  bankInfo: { type: String },
  passportInfo: { type: String },
  passportNo: { type: String },
  workPhone: { type: String },
  workAddress: { type: String },
  homePhone: { type: String },
  homeAddress: { type: String },
  mobilePhone: { type: String },
  emailAddress: { type: String },
  website: { type: String },
  coach: { type: String },
  showInStatistics: { type: Boolean, default: false },
  licenseNo: { type: String },
  startDate: { type: Date },
  province: { type: String },
  district: { type: String },
  institutionPosition: { type: String },
  club: { type: String },
  isAthlete: { type: Boolean, default: false },
  isVisuallyImpairedAthlete: { type: Boolean, default: false },
  isHearingImpairedAthlete: { type: Boolean, default: false },
  coachVisaYear: { type: Number },
  isCoach: { type: Boolean, default: false },
  coachStatus: { type: String },
  isReferee: { type: Boolean, default: false },
  refereeVisaYear: { type: Number },
  refereeStatus: { type: String },
  isProvincialRepresentative: { type: Boolean, default: false },
  isStaff: { type: Boolean, default: false },
  isBoardMember: { type: Boolean, default: false },
  boardDuty: { type: String },
  promotion: { type: String },
  promotionDate: { type: Date },
  tournamentCount: { type: Number, default: 0 },
  competitionCount: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  success: { type: String },
  weight: { type: Number },
  belt: { type: mongoose.Schema.Types.ObjectId, ref: "Belt" },
  beltHistory: [
    {
      belt: { type: mongoose.Schema.Types.ObjectId, ref: "Belt", populate: true },
      date: { type: Date, required: true },
      note: { type: String },
      updatedAt: { type: Date, default: Date.now }
    }
  ],
  athleteAchievements: [
    {
      rank: { type: Number },
      year: { type: Number },
      tournamentName: { type: String },
      weightCategory: { type: String },
      result: { type: String }
    }
  ],
});

// Belt değişikliğini otomatik olarak history'ye ekle
UserSchema.pre('save', function(next) {
  if (this.isModified('belt') && this.belt) {
    if (!this.beltHistory) {
      this.beltHistory = [];
    }
    
    // Eğer son kayıt ile aynı kuşak değilse yeni kayıt ekle
    if (this.beltHistory.length === 0 || 
        this.beltHistory[this.beltHistory.length - 1].belt.toString() !== this.belt.toString()) {
      this.beltHistory.push({
        belt: this.belt,
        date: new Date(),
        note: 'Otomatik kayıt'
      });
    }
  }
  next();
});

module.exports = mongoose.model("User", UserSchema);
