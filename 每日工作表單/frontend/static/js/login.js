const API = 'http://127.0.0.1:5000';

const STORAGE_KEY = "wms_account";
const getAccount = () => localStorage.getItem(STORAGE_KEY);
const setAccount = (a) => localStorage.setItem(STORAGE_KEY, a.toUpperCase());

// 進入登入頁即清除舊登入資訊，必須重新輸入帳密
localStorage.removeItem(STORAGE_KEY);

Vue.createApp({
  data() {
    return {
      account: "",
      password: "",
      showPwd: false,
      logging: false,
      errMsg: "",
      errField: "",
    };
  },

  methods: {
    onAccountInput() {
      this.errMsg = "";
      this.errField = "";
    },

    async doLogin() {
      this.errMsg = "";
      this.errField = "";
      if (!this.account) {
        this.errMsg = "請輸入帳號";
        this.errField = "account";
        this.$refs.accInput?.focus();
        return;
      }
      if (!this.password) {
        this.errMsg = "請輸入密碼";
        this.errField = "password";
        this.$refs.pwdInput?.focus();
        return;
      }
      this.logging = true;
      try {
        const res = await axios.post(API + "/api/login", {
          account: this.account.trim().toUpperCase(),
          password: this.password,
        });
        if (res.data.ok) {
          setAccount(this.account);
          location.href = "management/home.html";
        } else {
          this.errMsg = res.data.reason || "登入失敗";
          this.errField = "password";
        }
          } catch (e) {
            if (e.response?.status === 401) {
              this.errMsg   = e.response.data?.message || '帳號或密碼錯誤'
              this.errField = 'password'
            } else {
              this.errMsg = '無法連線至伺服器，請確認後端是否啟動'
            }
          } finally {
            this.logging = false
          }
        }
      },

  mounted() {
    this.$refs.accInput?.focus();
  },
}).mount("#app");
