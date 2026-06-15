"""routes 套件：彙整所有 Blueprint 並提供註冊函式。"""
from routes.auth_routes     import bp as auth_bp
from routes.admin_routes    import bp as admin_bp
from routes.task_routes     import bp as task_bp
from routes.progress_routes import bp as progress_bp
 
def register_routes(app):
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(task_bp)
    app.register_blueprint(progress_bp)